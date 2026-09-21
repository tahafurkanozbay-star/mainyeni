using Api.Core.Platform.Resilience;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class DependencyCircuitBreakerTests
{
    [Fact]
    public void Success_KeepsCircuitClosed()
    {
        var breaker = CreateBreaker();
        using var lease = breaker.TryAcquire("database");
        Assert.True(lease.IsAcquired);
        lease.Succeed();

        var snapshot = breaker.GetSnapshot("database");
        Assert.Equal(DependencyCircuitState.Closed, snapshot.State);
        Assert.Equal(1, snapshot.Successes);
        Assert.Equal(0, snapshot.ConsecutiveFailures);
    }

    [Fact]
    public void FailureThreshold_OpensCircuitAndRejectsWork()
    {
        var breaker = CreateBreaker(threshold: 2);
        using (var first = breaker.TryAcquire("search")) first.Fail();
        using (var second = breaker.TryAcquire("search")) second.Fail();

        using var rejected = breaker.TryAcquire("search");
        Assert.False(rejected.IsAcquired);
        Assert.NotNull(rejected.RetryAt);
        Assert.Equal(DependencyCircuitState.Open, breaker.GetSnapshot("search").State);
    }

    [Fact]
    public void SuccessfulHalfOpenProbe_ClosesCircuit()
    {
        var clock = new ManualTimeProvider();
        var breaker = CreateBreaker(threshold: 1, clock: clock);
        using (var failed = breaker.TryAcquire("database")) failed.Fail();

        clock.Advance(TimeSpan.FromSeconds(31));
        using var probe = breaker.TryAcquire("database");
        Assert.True(probe.IsAcquired);
        Assert.Equal(DependencyCircuitState.HalfOpen, breaker.GetSnapshot("database").State);
        probe.Succeed();

        Assert.Equal(DependencyCircuitState.Closed, breaker.GetSnapshot("database").State);
    }

    [Fact]
    public void OnlyOneHalfOpenProbe_IsAllowed()
    {
        var clock = new ManualTimeProvider();
        var breaker = CreateBreaker(threshold: 1, clock: clock);
        using (var failed = breaker.TryAcquire("database")) failed.Fail();
        clock.Advance(TimeSpan.FromSeconds(31));

        using var first = breaker.TryAcquire("database");
        using var second = breaker.TryAcquire("database");

        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
    }

    [Fact]
    public void FailedHalfOpenProbe_ReopensCircuit()
    {
        var clock = new ManualTimeProvider();
        var breaker = CreateBreaker(threshold: 1, clock: clock);
        using (var failed = breaker.TryAcquire("database")) failed.Fail();
        clock.Advance(TimeSpan.FromSeconds(31));

        using (var probe = breaker.TryAcquire("database")) probe.Fail();

        Assert.Equal(DependencyCircuitState.Open, breaker.GetSnapshot("database").State);
        using var rejected = breaker.TryAcquire("database");
        Assert.False(rejected.IsAcquired);
    }

    [Fact]
    public void DisposeWithoutOutcome_ReleasesHalfOpenProbeWithoutChangingFailureCount()
    {
        var clock = new ManualTimeProvider();
        var breaker = CreateBreaker(threshold: 1, clock: clock);
        using (var failed = breaker.TryAcquire("database")) failed.Fail();
        clock.Advance(TimeSpan.FromSeconds(31));

        breaker.TryAcquire("database").Dispose();
        using var replacementProbe = breaker.TryAcquire("database");

        Assert.True(replacementProbe.IsAcquired);
        Assert.Equal(1, breaker.GetSnapshot("database").Failures);
    }

    [Fact]
    public void Completion_IsIdempotent()
    {
        var breaker = CreateBreaker();
        using var lease = breaker.TryAcquire("database");
        lease.Fail();
        lease.Fail();
        lease.Succeed();

        var snapshot = breaker.GetSnapshot("database");
        Assert.Equal(1, snapshot.Failures);
        Assert.Equal(0, snapshot.Successes);
    }

    [Fact]
    public void DependencyKeys_AreNormalized()
    {
        var breaker = CreateBreaker();
        using var lease = breaker.TryAcquire("  DATABASE  ");
        lease.Fail();

        Assert.Equal(1, breaker.GetSnapshot("database").Failures);
    }

    [Fact]
    public void UnknownDependencies_ShareOnePartition()
    {
        var breaker = CreateBreaker(threshold: 1);
        using (var lease = breaker.TryAcquire(null)) lease.Fail();

        using var rejected = breaker.TryAcquire("   ");
        Assert.False(rejected.IsAcquired);
    }

    [Fact]
    public void TrackedDependencyCardinality_IsBounded()
    {
        var breaker = new DependencyCircuitBreaker(new DependencyCircuitBreakerOptions
        {
            FailureThreshold = 5,
            MaxTrackedDependencies = 4,
            CleanupInterval = 1000
        });

        for (var index = 0; index < 20; index++)
        {
            using var lease = breaker.TryAcquire("dependency:" + index);
            lease.Succeed();
        }

        Assert.True(breaker.TrackedDependencies <= 5);
    }

    [Fact]
    public void Snapshot_DoesNotRequireExistingCircuit()
    {
        var breaker = CreateBreaker();
        var snapshot = breaker.GetSnapshot("never-called");

        Assert.Equal(DependencyCircuitState.Closed, snapshot.State);
        Assert.Equal(0, snapshot.Failures);
        Assert.Equal(0, snapshot.Rejections);
    }

    private static DependencyCircuitBreaker CreateBreaker(
        int threshold = 3,
        TimeProvider? clock = null) => new(
            new DependencyCircuitBreakerOptions
            {
                FailureThreshold = threshold,
                OpenDuration = TimeSpan.FromSeconds(30),
                HalfOpenRetryDelay = TimeSpan.FromSeconds(1),
                CleanupInterval = 64,
                MaxTrackedDependencies = 32
            },
            clock);

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset now = new(2026, 9, 21, 8, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
}
