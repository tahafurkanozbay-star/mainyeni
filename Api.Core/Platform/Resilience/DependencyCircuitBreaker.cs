using System;
using System.Collections.Concurrent;
using System.Threading;

namespace Api.Core.Platform.Resilience;

public enum DependencyCircuitState
{
    Closed,
    Open,
    HalfOpen
}

public readonly record struct DependencyCircuitSnapshot(
    string Dependency,
    DependencyCircuitState State,
    int ConsecutiveFailures,
    DateTimeOffset? OpenedAt,
    DateTimeOffset? RetryAt,
    long Successes,
    long Failures,
    long Rejections);

/// <summary>
/// Small in-process circuit breaker for server-side dependency boundaries. It deliberately owns
/// no timers and performs no network I/O: callers wrap their existing dependency operation and
/// report the outcome. State is bounded by the configured dependency cardinality and idle entries
/// are removed opportunistically.
/// </summary>
public sealed class DependencyCircuitBreaker
{
    private const string OverflowKey = "__overflow__";
    private readonly ConcurrentDictionary<string, Circuit> circuits = new(StringComparer.Ordinal);
    private readonly DependencyCircuitBreakerOptions options;
    private readonly TimeProvider timeProvider;
    private long operations;

    public DependencyCircuitBreaker(
        DependencyCircuitBreakerOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        this.options = options ?? new DependencyCircuitBreakerOptions();
        this.timeProvider = timeProvider ?? TimeProvider.System;
        this.options.Validate();
    }

    public int TrackedDependencies => circuits.Count;

    public DependencyCircuitLease TryAcquire(string? dependency)
    {
        var now = timeProvider.GetUtcNow();
        var key = NormalizeKey(dependency);
        var circuit = GetCircuit(key, now);
        MaybeCleanup(now);

        lock (circuit.Sync)
        {
            circuit.LastTouched = now;
            if (circuit.State == DependencyCircuitState.Open)
            {
                var retryAt = circuit.OpenedAt!.Value + options.OpenDuration;
                if (now < retryAt)
                {
                    circuit.Rejections++;
                    return DependencyCircuitLease.Rejected(this, key, circuit, retryAt);
                }

                circuit.State = DependencyCircuitState.HalfOpen;
                circuit.HalfOpenProbeInFlight = false;
            }

            if (circuit.State == DependencyCircuitState.HalfOpen)
            {
                if (circuit.HalfOpenProbeInFlight)
                {
                    circuit.Rejections++;
                    return DependencyCircuitLease.Rejected(
                        this,
                        key,
                        circuit,
                        now + options.HalfOpenRetryDelay);
                }

                circuit.HalfOpenProbeInFlight = true;
            }

            return DependencyCircuitLease.Acquired(this, key, circuit);
        }
    }

    public DependencyCircuitSnapshot GetSnapshot(string? dependency)
    {
        var key = NormalizeKey(dependency);
        if (!circuits.TryGetValue(key, out var circuit))
        {
            return new DependencyCircuitSnapshot(
                key,
                DependencyCircuitState.Closed,
                0,
                null,
                null,
                0,
                0,
                0);
        }

        lock (circuit.Sync)
        {
            var retryAt = circuit.State == DependencyCircuitState.Open && circuit.OpenedAt.HasValue
                ? circuit.OpenedAt.Value + options.OpenDuration
                : null;
            return new DependencyCircuitSnapshot(
                key,
                circuit.State,
                circuit.ConsecutiveFailures,
                circuit.OpenedAt,
                retryAt,
                circuit.Successes,
                circuit.Failures,
                circuit.Rejections);
        }
    }

    private Circuit GetCircuit(string key, DateTimeOffset now)
    {
        if (circuits.TryGetValue(key, out var existing))
        {
            return existing;
        }

        if (circuits.Count >= options.MaxTrackedDependencies)
        {
            key = OverflowKey;
        }

        return circuits.GetOrAdd(key, _ => new Circuit(now));
    }

    private void Complete(Circuit circuit, bool succeeded)
    {
        var now = timeProvider.GetUtcNow();
        lock (circuit.Sync)
        {
            circuit.LastTouched = now;
            circuit.HalfOpenProbeInFlight = false;

            if (succeeded)
            {
                circuit.Successes++;
                circuit.ConsecutiveFailures = 0;
                circuit.OpenedAt = null;
                circuit.State = DependencyCircuitState.Closed;
                return;
            }

            circuit.Failures++;
            circuit.ConsecutiveFailures++;
            if (circuit.State == DependencyCircuitState.HalfOpen ||
                circuit.ConsecutiveFailures >= options.FailureThreshold)
            {
                circuit.State = DependencyCircuitState.Open;
                circuit.OpenedAt = now;
            }
        }
    }

    private void Abandon(Circuit circuit)
    {
        lock (circuit.Sync)
        {
            circuit.HalfOpenProbeInFlight = false;
        }
    }

    private void MaybeCleanup(DateTimeOffset now)
    {
        var count = Interlocked.Increment(ref operations);
        if (count % options.CleanupInterval != 0)
        {
            return;
        }

        var cutoff = now - options.IdleEntryLifetime;
        foreach (var pair in circuits)
        {
            if (pair.Key == OverflowKey)
            {
                continue;
            }

            var circuit = pair.Value;
            lock (circuit.Sync)
            {
                if (circuit.State == DependencyCircuitState.Closed &&
                    !circuit.HalfOpenProbeInFlight &&
                    circuit.LastTouched < cutoff)
                {
                    circuits.TryRemove(new KeyValuePair<string, Circuit>(pair.Key, circuit));
                }
            }
        }
    }

    private static string NormalizeKey(string? dependency)
    {
        if (string.IsNullOrWhiteSpace(dependency))
        {
            return "unknown";
        }

        var trimmed = dependency.Trim().ToLowerInvariant();
        return trimmed.Length <= 128 ? trimmed : trimmed[..128];
    }

    private sealed class Circuit
    {
        public Circuit(DateTimeOffset now) => LastTouched = now;
        public object Sync { get; } = new();
        public DependencyCircuitState State { get; set; }
        public int ConsecutiveFailures { get; set; }
        public DateTimeOffset? OpenedAt { get; set; }
        public DateTimeOffset LastTouched { get; set; }
        public bool HalfOpenProbeInFlight { get; set; }
        public long Successes { get; set; }
        public long Failures { get; set; }
        public long Rejections { get; set; }
    }

    public sealed class DependencyCircuitLease : IDisposable
    {
        private readonly DependencyCircuitBreaker? owner;
        private readonly Circuit? circuit;
        private int completed;

        private DependencyCircuitLease(
            DependencyCircuitBreaker? owner,
            string dependency,
            Circuit? circuit,
            bool isAcquired,
            DateTimeOffset? retryAt)
        {
            this.owner = owner;
            this.circuit = circuit;
            Dependency = dependency;
            IsAcquired = isAcquired;
            RetryAt = retryAt;
        }

        public string Dependency { get; }
        public bool IsAcquired { get; }
        public DateTimeOffset? RetryAt { get; }

        internal static DependencyCircuitLease Acquired(
            DependencyCircuitBreaker owner,
            string dependency,
            Circuit circuit) => new(owner, dependency, circuit, true, null);

        internal static DependencyCircuitLease Rejected(
            DependencyCircuitBreaker owner,
            string dependency,
            Circuit circuit,
            DateTimeOffset retryAt) => new(owner, dependency, circuit, false, retryAt);

        public void Succeed() => Complete(true);
        public void Fail() => Complete(false);

        private void Complete(bool succeeded)
        {
            if (!IsAcquired || owner is null || circuit is null ||
                Interlocked.Exchange(ref completed, 1) != 0)
            {
                return;
            }

            owner.Complete(circuit, succeeded);
        }

        public void Dispose()
        {
            if (!IsAcquired || owner is null || circuit is null ||
                Interlocked.Exchange(ref completed, 1) != 0)
            {
                return;
            }

            owner.Abandon(circuit);
        }
    }
}

public sealed class DependencyCircuitBreakerOptions
{
    public int FailureThreshold { get; init; } = 5;
    public TimeSpan OpenDuration { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan HalfOpenRetryDelay { get; init; } = TimeSpan.FromSeconds(1);
    public int MaxTrackedDependencies { get; init; } = 128;
    public TimeSpan IdleEntryLifetime { get; init; } = TimeSpan.FromMinutes(10);
    public int CleanupInterval { get; init; } = 256;

    internal void Validate()
    {
        if (FailureThreshold < 1) throw new ArgumentOutOfRangeException(nameof(FailureThreshold));
        if (OpenDuration <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(OpenDuration));
        if (HalfOpenRetryDelay < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(HalfOpenRetryDelay));
        if (MaxTrackedDependencies < 1) throw new ArgumentOutOfRangeException(nameof(MaxTrackedDependencies));
        if (IdleEntryLifetime <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(IdleEntryLifetime));
        if (CleanupInterval < 1) throw new ArgumentOutOfRangeException(nameof(CleanupInterval));
    }
}
