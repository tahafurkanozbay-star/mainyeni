using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Fail-fast in-process bulkhead for API requests. It bounds both process-wide concurrency and
    /// per-client concurrency without allocating a waiting queue. Client keys are already
    /// privacy-preserving limiter partitions and are capped through an overflow bucket so malicious
    /// high-cardinality traffic cannot grow this dictionary without bound.
    /// </summary>
    public sealed class RequestConcurrencyGovernor
    {
        private const string OverflowPartition = "client:overflow";
        private const string LongPartitionPrefix = "client:long:";
        private const int MaxInlinePartitionLength = 160;

        private readonly ConcurrentDictionary<string, ClientState> clients =
            new ConcurrentDictionary<string, ClientState>(StringComparer.Ordinal);

        // ConcurrentDictionary makes individual mutations safe, but Count + GetOrAdd is not an
        // atomic admission decision. Serialize only previously unseen partition registration so a
        // burst of unique client keys cannot race past maxTrackedClients. Existing-client lookups
        // remain lock-free, which keeps the normal request path cheap.
        private readonly object clientRegistrationGate = new object();

        private readonly int maxConcurrentRequests;
        private readonly int maxConcurrentPerClient;
        private readonly int maxTrackedClients;
        private readonly long idleTicks;
        private readonly int cleanupInterval;
        private readonly TimeProvider timeProvider;
        private long activeRequests;
        private long acquisitionAttempts;

        public RequestConcurrencyGovernor(ApiPlatformOptions options)
            : this(options, TimeProvider.System)
        {
        }

        /// <summary>
        /// Creates a governor with an explicit clock. The overload keeps time-dependent admission
        /// semantics deterministic in regression tests while production uses <see cref="TimeProvider.System"/>.
        /// </summary>
        public RequestConcurrencyGovernor(
            ApiPlatformOptions options,
            TimeProvider timeProvider)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            this.timeProvider = timeProvider
                ?? throw new ArgumentNullException(nameof(timeProvider));

            var configuration = options.Governance?.Concurrency
                ?? new ApiPlatformOptions.ConcurrencyOptions();

            maxConcurrentRequests = Math.Max(1, configuration.MaxConcurrentRequests);
            maxConcurrentPerClient = Math.Max(1, configuration.MaxConcurrentPerClient);
            maxTrackedClients = Math.Max(16, configuration.MaxTrackedClients);
            idleTicks = TimeSpan
                .FromSeconds(Math.Max(1, configuration.ClientIdleSeconds))
                .Ticks;
            cleanupInterval = Math.Max(16, configuration.CleanupInterval);
        }

        public int ActiveRequests
        {
            get
            {
                var value = Interlocked.Read(ref activeRequests);
                return value >= int.MaxValue ? int.MaxValue : (int)value;
            }
        }

        public int TrackedClients => clients.Count;

        public RequestConcurrencyLease TryAcquire(string partitionKey)
        {
            var normalizedKey = NormalizePartitionKey(partitionKey);
            var now = GetUtcTicks();

            var global = Interlocked.Increment(ref activeRequests);
            if (global > maxConcurrentRequests)
            {
                Interlocked.Decrement(ref activeRequests);
                MaybeCleanup(now);
                return RequestConcurrencyLease.Rejected(
                    this,
                    normalizedKey,
                    RequestConcurrencyRejection.GlobalLimit);
            }

            while (true)
            {
                var state = ResolveClientState(normalizedKey, now);
                var clientLimitExceeded = false;

                // Cleanup and acquisition coordinate only within one client state. This prevents
                // cleanup from detaching an idle state between lookup and Active increment while
                // preserving parallelism across unrelated clients.
                lock (state.Gate)
                {
                    if (!IsRegisteredState(normalizedKey, state))
                    {
                        // Cleanup removed this state after ResolveClientState returned it. Retry
                        // against the dictionary without consuming another global slot.
                        continue;
                    }

                    state.Active++;
                    state.LastSeenTicks = now;

                    if (state.Active > maxConcurrentPerClient)
                    {
                        state.Active--;
                        clientLimitExceeded = true;
                    }
                }

                if (clientLimitExceeded)
                {
                    Interlocked.Decrement(ref activeRequests);
                    MaybeCleanup(now);
                    return RequestConcurrencyLease.Rejected(
                        this,
                        normalizedKey,
                        RequestConcurrencyRejection.ClientLimit);
                }

                MaybeCleanup(now);
                return RequestConcurrencyLease.Acquired(this, normalizedKey, state);
            }
        }

        public RequestConcurrencySnapshot GetSnapshot()
        {
            return new RequestConcurrencySnapshot(
                activeRequests: ActiveRequests,
                trackedClients: TrackedClients,
                maxConcurrentRequests: maxConcurrentRequests,
                maxConcurrentPerClient: maxConcurrentPerClient,
                maxTrackedClients: maxTrackedClients);
        }

        internal void Release(string partitionKey, object stateObject)
        {
            if (stateObject is ClientState state)
            {
                lock (state.Gate)
                {
                    if (state.Active > 0)
                    {
                        state.Active--;
                    }

                    state.LastSeenTicks = GetUtcTicks();
                }
            }

            var global = Interlocked.Decrement(ref activeRequests);
            if (global < 0)
            {
                Interlocked.Exchange(ref activeRequests, 0);
            }
        }

        private ClientState ResolveClientState(string partitionKey, long now)
        {
            if (clients.TryGetValue(partitionKey, out var existing))
            {
                return existing;
            }

            lock (clientRegistrationGate)
            {
                // A partition can be registered while this caller is waiting for the gate.
                // Re-check before applying the cardinality decision so all unseen-key admissions
                // observe one ordered Count/GetOrAdd boundary.
                if (clients.TryGetValue(partitionKey, out existing))
                {
                    return existing;
                }

                // Reserve the final configured slot for the overflow partition. Under sustained
                // churn, expired idle partitions are reclaimed synchronously before unrelated
                // callers are coalesced into overflow. This preserves per-client isolation when
                // capacity exists logically even if the periodic bounded cleanup has not sampled
                // the stale dictionary entries yet.
                if (clients.Count >= maxTrackedClients - 1)
                {
                    ReclaimExpiredIdleClient(now);
                }

                if (clients.Count >= maxTrackedClients - 1)
                {
                    return clients.GetOrAdd(
                        OverflowPartition,
                        _ => new ClientState(now));
                }

                return clients.GetOrAdd(
                    partitionKey,
                    _ => new ClientState(now));
            }
        }

        private bool ReclaimExpiredIdleClient(long now)
        {
            var cutoff = ComputeIdleCutoff(now);
            List<IdleCandidate> candidates = null;

            // This full scan only runs at the cardinality boundary. Normal acquisitions continue
            // to use the bounded periodic cleanup path below. Candidate snapshots are value-free:
            // only already-pseudonymous partition keys and aggregate timestamps are retained.
            foreach (var pair in clients)
            {
                if (pair.Key == OverflowPartition)
                {
                    continue;
                }

                var state = pair.Value;
                long lastSeen;
                lock (state.Gate)
                {
                    if (state.Active != 0 || state.LastSeenTicks >= cutoff)
                    {
                        continue;
                    }

                    lastSeen = state.LastSeenTicks;
                }

                candidates ??= new List<IdleCandidate>();
                candidates.Add(new IdleCandidate(pair.Key, state, lastSeen));
            }

            if (candidates == null || candidates.Count == 0)
            {
                return false;
            }

            candidates.Sort(static (left, right) =>
            {
                var timestampOrder = left.LastSeenTicks.CompareTo(right.LastSeenTicks);
                return timestampOrder != 0
                    ? timestampOrder
                    : StringComparer.Ordinal.Compare(left.PartitionKey, right.PartitionKey);
            });

            foreach (var candidate in candidates)
            {
                lock (candidate.State.Gate)
                {
                    // The state can become active after the snapshot because existing-key
                    // acquisitions do not take clientRegistrationGate. Revalidate all eviction
                    // predicates while holding the state gate before removing by identity.
                    if (candidate.State.Active != 0 ||
                        candidate.State.LastSeenTicks >= cutoff)
                    {
                        continue;
                    }

                    if (clients.TryRemove(
                        new KeyValuePair<string, ClientState>(
                            candidate.PartitionKey,
                            candidate.State)))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private bool IsRegisteredState(string partitionKey, ClientState state)
        {
            if (clients.TryGetValue(partitionKey, out var registered) &&
                ReferenceEquals(registered, state))
            {
                return true;
            }

            // Once cardinality reaches the configured bound, unrelated client keys intentionally
            // share the non-removable overflow state.
            return clients.TryGetValue(OverflowPartition, out registered) &&
                   ReferenceEquals(registered, state);
        }

        private void MaybeCleanup(long now)
        {
            var attempt = Interlocked.Increment(ref acquisitionAttempts);
            if (attempt % cleanupInterval != 0)
            {
                return;
            }

            var cutoff = ComputeIdleCutoff(now);
            var scanned = 0;
            var scanBudget = Math.Min(Math.Max(32, maxTrackedClients / 8), 512);

            foreach (var pair in clients)
            {
                if (scanned++ >= scanBudget)
                {
                    break;
                }

                if (pair.Key == OverflowPartition)
                {
                    continue;
                }

                var state = pair.Value;
                lock (state.Gate)
                {
                    if (state.Active != 0)
                    {
                        continue;
                    }

                    if (state.LastSeenTicks >= cutoff)
                    {
                        continue;
                    }

                    clients.TryRemove(
                        new KeyValuePair<string, ClientState>(
                            pair.Key,
                            state));
                }
            }
        }

        private long ComputeIdleCutoff(long now)
        {
            return now <= idleTicks
                ? 0
                : now - idleTicks;
        }

        private long GetUtcTicks()
        {
            return timeProvider.GetUtcNow().UtcDateTime.Ticks;
        }

        private static string NormalizePartitionKey(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "client:unknown";
            }

            var trimmed = value.Trim();
            if (trimmed.Length <= MaxInlinePartitionLength)
            {
                return trimmed;
            }

            // Truncation would collapse attacker-controlled or future partition formats that share
            // a long prefix into one per-client budget. A fixed 96-bit SHA-256 token keeps the key
            // bounded without retaining the original identifier and makes accidental collisions
            // negligibly likely for this in-process cardinality domain.
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(trimmed));
            return LongPartitionPrefix +
                   Convert.ToHexString(digest.AsSpan(0, 12)).ToLowerInvariant();
        }

        private sealed class ClientState
        {
            public ClientState(long now)
            {
                LastSeenTicks = now;
            }

            public object Gate { get; } = new object();

            public int Active;

            public long LastSeenTicks;
        }

        private readonly struct IdleCandidate
        {
            public IdleCandidate(
                string partitionKey,
                ClientState state,
                long lastSeenTicks)
            {
                PartitionKey = partitionKey;
                State = state;
                LastSeenTicks = lastSeenTicks;
            }

            public string PartitionKey { get; }

            public ClientState State { get; }

            public long LastSeenTicks { get; }
        }
    }

    public enum RequestConcurrencyRejection
    {
        None = 0,
        GlobalLimit = 1,
        ClientLimit = 2
    }

    public readonly struct RequestConcurrencySnapshot
    {
        public RequestConcurrencySnapshot(
            int activeRequests,
            int trackedClients,
            int maxConcurrentRequests,
            int maxConcurrentPerClient,
            int maxTrackedClients)
        {
            ActiveRequests = activeRequests;
            TrackedClients = trackedClients;
            MaxConcurrentRequests = maxConcurrentRequests;
            MaxConcurrentPerClient = maxConcurrentPerClient;
            MaxTrackedClients = maxTrackedClients;
        }

        public int ActiveRequests { get; }

        public int TrackedClients { get; }

        public int MaxConcurrentRequests { get; }

        public int MaxConcurrentPerClient { get; }

        public int MaxTrackedClients { get; }
    }

    public sealed class RequestConcurrencyLease : IDisposable
    {
        private RequestConcurrencyGovernor owner;
        private readonly string partitionKey;
        private readonly object state;
        private int disposed;

        private RequestConcurrencyLease(
            RequestConcurrencyGovernor owner,
            string partitionKey,
            object state,
            bool isAcquired,
            RequestConcurrencyRejection rejection)
        {
            this.owner = owner;
            this.partitionKey = partitionKey;
            this.state = state;
            IsAcquired = isAcquired;
            Rejection = rejection;
        }

        public bool IsAcquired { get; }

        public RequestConcurrencyRejection Rejection { get; }

        public void Dispose()
        {
            if (!IsAcquired ||
                Interlocked.Exchange(ref disposed, 1) != 0)
            {
                return;
            }

            var currentOwner = Interlocked.Exchange(ref owner, null);
            currentOwner?.Release(partitionKey, state);
        }

        internal static RequestConcurrencyLease Acquired(
            RequestConcurrencyGovernor owner,
            string partitionKey,
            object state)
        {
            return new RequestConcurrencyLease(
                owner,
                partitionKey,
                state,
                isAcquired: true,
                rejection: RequestConcurrencyRejection.None);
        }

        internal static RequestConcurrencyLease Rejected(
            RequestConcurrencyGovernor owner,
            string partitionKey,
            RequestConcurrencyRejection rejection)
        {
            return new RequestConcurrencyLease(
                owner,
                partitionKey,
                state: null,
                isAcquired: false,
                rejection: rejection);
        }
    }
}
