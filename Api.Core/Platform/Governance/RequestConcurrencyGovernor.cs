using System;
using System.Collections.Concurrent;
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
        private long activeRequests;
        private long acquisitionAttempts;

        public RequestConcurrencyGovernor(ApiPlatformOptions options)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

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
            var now = DateTime.UtcNow.Ticks;

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

                    state.LastSeenTicks = DateTime.UtcNow.Ticks;
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

                // Reserve the final configured slot for the overflow partition. Without this
                // reservation, admitting maxTrackedClients unique keys and then creating overflow
                // would make the observable dictionary cardinality maxTrackedClients + 1.
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

            var cutoff = now - idleTicks;
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
                        new System.Collections.Generic.KeyValuePair<string, ClientState>(
                            pair.Key,
                            state));
                }
            }
        }

        private static string NormalizePartitionKey(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "client:unknown";
            }

            var trimmed = value.Trim();
            if (trimmed.Length <= 160)
            {
                return trimmed;
            }

            return trimmed.Substring(0, 160);
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
