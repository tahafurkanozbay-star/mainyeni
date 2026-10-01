using Api.Core.Platform;
using Api.Core.Platform.Governance;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestConcurrencyGovernorLifecycleTests
{
    [Fact]
    public void Constructor_RejectsMissingTimeProvider()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new RequestConcurrencyGovernor(CreateOptions(), null!));
    }

    [Fact]
    public void ExpiredIdlePartitions_AreReclaimedBeforeOverflow()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(clock, perClient: 1, idleSeconds: 30);

        FillNormalPartitionCapacity(governor, 15);
        Assert.Equal(15, governor.TrackedClients);

        clock.Advance(TimeSpan.FromSeconds(31));

        using var firstFresh = governor.TryAcquire("fresh:a");
        using var secondFresh = governor.TryAcquire("fresh:b");

        Assert.True(firstFresh.IsAcquired);
        Assert.True(secondFresh.IsAcquired);
        Assert.Equal(2, governor.ActiveRequests);
        Assert.Equal(15, governor.TrackedClients);
    }

    [Fact]
    public void NonExpiredIdlePartitions_DoNotGetReclaimedAtCapacity()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(clock, perClient: 1, idleSeconds: 30);

        FillNormalPartitionCapacity(governor, 15);

        using var firstOverflow = governor.TryAcquire("fresh:a");
        using var secondOverflow = governor.TryAcquire("fresh:b");

        Assert.True(firstOverflow.IsAcquired);
        Assert.False(secondOverflow.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, secondOverflow.Rejection);
        Assert.Equal(16, governor.TrackedClients);
    }

    [Fact]
    public void ActivePartitions_AreNeverReclaimedAfterIdleWindow()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(
            clock,
            global: 64,
            perClient: 1,
            idleSeconds: 10);
        var held = new List<RequestConcurrencyLease>();

        try
        {
            for (var index = 0; index < 15; index++)
            {
                var lease = governor.TryAcquire("held:" + index);
                Assert.True(lease.IsAcquired);
                held.Add(lease);
            }

            clock.Advance(TimeSpan.FromMinutes(1));

            using var firstOverflow = governor.TryAcquire("new:a");
            using var secondOverflow = governor.TryAcquire("new:b");

            Assert.True(firstOverflow.IsAcquired);
            Assert.False(secondOverflow.IsAcquired);
            Assert.Equal(RequestConcurrencyRejection.ClientLimit, secondOverflow.Rejection);
            Assert.Equal(16, governor.TrackedClients);
            Assert.Equal(16, governor.ActiveRequests);
        }
        finally
        {
            foreach (var lease in held)
            {
                lease.Dispose();
            }
        }

        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public void BoundaryReclamation_UsesExpiredStateWithoutGrowingDictionary()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(clock, perClient: 2, idleSeconds: 5);

        FillNormalPartitionCapacity(governor, 15);
        clock.Advance(TimeSpan.FromSeconds(6));

        for (var index = 0; index < 100; index++)
        {
            using var lease = governor.TryAcquire("replacement:" + index);
            Assert.True(lease.IsAcquired);
            Assert.True(governor.TrackedClients <= 15);
            clock.Advance(TimeSpan.FromSeconds(6));
        }

        Assert.Equal(0, governor.ActiveRequests);
        Assert.True(governor.TrackedClients <= 15);
    }

    [Fact]
    public void ReclamationOnlyEvictsEntriesOlderThanCutoff()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(clock, perClient: 1, idleSeconds: 10);

        using (var oldest = governor.TryAcquire("oldest"))
        {
            Assert.True(oldest.IsAcquired);
        }

        clock.Advance(TimeSpan.FromSeconds(1));

        for (var index = 0; index < 14; index++)
        {
            using var lease = governor.TryAcquire("recent:" + index);
            Assert.True(lease.IsAcquired);
        }

        Assert.Equal(15, governor.TrackedClients);
        clock.Advance(TimeSpan.FromSeconds(10));

        // cutoff == t+1s. Only the entry released at t0 is strictly older than it.
        using var replacement = governor.TryAcquire("replacement");
        Assert.True(replacement.IsAcquired);
        Assert.Equal(15, governor.TrackedClients);

        // The recent entry was not evicted because its LastSeen is exactly the cutoff.
        using var recent = governor.TryAcquire("recent:0");
        Assert.True(recent.IsAcquired);
    }

    [Fact]
    public void ClockRollback_DoesNotExpireFutureDatedIdlePartitions()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(clock, perClient: 1, idleSeconds: 30);

        FillNormalPartitionCapacity(governor, 15);
        clock.Advance(TimeSpan.FromMinutes(-5));

        using var firstOverflow = governor.TryAcquire("rollback:a");
        using var secondOverflow = governor.TryAcquire("rollback:b");

        Assert.True(firstOverflow.IsAcquired);
        Assert.False(secondOverflow.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, secondOverflow.Rejection);
        Assert.Equal(16, governor.TrackedClients);
    }

    [Fact]
    public void LongKeysSharingFirst160Characters_GetIndependentBudgets()
    {
        var governor = CreateGovernor(new ManualTimeProvider(), perClient: 1);
        var prefix = new string('x', 180);

        using var first = governor.TryAcquire(prefix + ":alpha");
        using var second = governor.TryAcquire(prefix + ":beta");

        Assert.True(first.IsAcquired);
        Assert.True(second.IsAcquired);
        Assert.Equal(2, governor.ActiveRequests);
        Assert.Equal(2, governor.TrackedClients);
    }

    [Fact]
    public void SameLongKey_StillUsesSameDeterministicBudget()
    {
        var governor = CreateGovernor(new ManualTimeProvider(), perClient: 1);
        var key = new string('z', 512);

        using var first = governor.TryAcquire(key);
        using var second = governor.TryAcquire(key);

        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, second.Rejection);
        Assert.Equal(1, governor.TrackedClients);
    }

    [Fact]
    public void WhitespaceAroundLongKey_DoesNotCreateAnotherPartition()
    {
        var governor = CreateGovernor(new ManualTimeProvider(), perClient: 1);
        var key = new string('q', 512);

        using var first = governor.TryAcquire(key);
        using var second = governor.TryAcquire("   " + key + "   ");

        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, second.Rejection);
        Assert.Equal(1, governor.TrackedClients);
    }

    [Fact]
    public async Task ConcurrentExpiredCapacityPressure_RemainsStrictlyBounded()
    {
        const int contenders = 128;
        const int maxTrackedClients = 16;
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(
            clock,
            global: contenders,
            perClient: contenders,
            maxTrackedClients: maxTrackedClients,
            idleSeconds: 1);

        FillNormalPartitionCapacity(governor, maxTrackedClients - 1);
        clock.Advance(TimeSpan.FromSeconds(2));

        using var start = new ManualResetEventSlim(false);
        var leases = new ConcurrentBag<RequestConcurrencyLease>();
        var tasks = Enumerable.Range(0, contenders)
            .Select(index => Task.Run(() =>
            {
                start.Wait();
                leases.Add(governor.TryAcquire("pressure:" + index));
            }))
            .ToArray();

        start.Set();
        await Task.WhenAll(tasks);

        try
        {
            Assert.Equal(contenders, leases.Count);
            Assert.All(leases, static lease => Assert.True(lease.IsAcquired));
            Assert.Equal(contenders, governor.ActiveRequests);
            Assert.True(governor.TrackedClients <= maxTrackedClients);
        }
        finally
        {
            foreach (var lease in leases)
            {
                lease.Dispose();
            }
        }

        Assert.Equal(0, governor.ActiveRequests);
        Assert.True(governor.TrackedClients <= maxTrackedClients);
    }

    [Fact]
    public async Task ConcurrentExistingClientAndReclamation_NeverDetachesActiveState()
    {
        const int iterations = 100;
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(
            clock,
            global: 64,
            perClient: 1,
            maxTrackedClients: 16,
            idleSeconds: 1);

        for (var iteration = 0; iteration < iterations; iteration++)
        {
            FillToCapacityWithReusableKeys(governor);
            clock.Advance(TimeSpan.FromSeconds(2));

            using var held = governor.TryAcquire("stable");
            Assert.True(held.IsAcquired);

            var probes = Enumerable.Range(0, 32)
                .Select(index => Task.Run(() =>
                {
                    using var noise = governor.TryAcquire(
                        "iteration:" + iteration + ":" + index);
                    using var competing = governor.TryAcquire("stable");
                    return competing.IsAcquired;
                }))
                .ToArray();

            var results = await Task.WhenAll(probes);
            Assert.DoesNotContain(true, results);
            Assert.True(governor.TrackedClients <= 16);
        }

        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public void SnapshotRemainsAggregateAfterReclamation()
    {
        var clock = new ManualTimeProvider();
        var governor = CreateGovernor(clock, maxTrackedClients: 16, idleSeconds: 1);

        FillNormalPartitionCapacity(governor, 15);
        clock.Advance(TimeSpan.FromSeconds(2));
        using var lease = governor.TryAcquire("fresh-client");

        var snapshot = governor.GetSnapshot();

        Assert.Equal(1, snapshot.ActiveRequests);
        Assert.Equal(16, snapshot.MaxTrackedClients);
        Assert.True(snapshot.TrackedClients <= 16);
        Assert.Equal(64, snapshot.MaxConcurrentRequests);
        Assert.Equal(4, snapshot.MaxConcurrentPerClient);
    }

    private static void FillNormalPartitionCapacity(
        RequestConcurrencyGovernor governor,
        int count)
    {
        for (var index = 0; index < count; index++)
        {
            using var lease = governor.TryAcquire("seed:" + index);
            Assert.True(lease.IsAcquired);
        }
    }

    private static void FillToCapacityWithReusableKeys(
        RequestConcurrencyGovernor governor)
    {
        for (var index = 0; index < 15; index++)
        {
            using var lease = governor.TryAcquire("reusable:" + index);
        }
    }

    private static RequestConcurrencyGovernor CreateGovernor(
        TimeProvider clock,
        int global = 64,
        int perClient = 4,
        int maxTrackedClients = 16,
        int idleSeconds = 120)
    {
        var options = CreateOptions(
            global,
            perClient,
            maxTrackedClients,
            idleSeconds);

        return new RequestConcurrencyGovernor(options, clock);
    }

    private static ApiPlatformOptions CreateOptions(
        int global = 64,
        int perClient = 4,
        int maxTrackedClients = 16,
        int idleSeconds = 120)
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = global;
        options.Governance.Concurrency.MaxConcurrentPerClient = perClient;
        options.Governance.Concurrency.MaxTrackedClients = maxTrackedClients;
        options.Governance.Concurrency.ClientIdleSeconds = idleSeconds;
        options.Governance.Concurrency.CleanupInterval = 100000;
        return options;
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private long utcTicks = new DateTimeOffset(
            2026,
            9,
            30,
            12,
            0,
            0,
            TimeSpan.Zero).UtcDateTime.Ticks;

        public override DateTimeOffset GetUtcNow()
        {
            return new DateTimeOffset(
                Interlocked.Read(ref utcTicks),
                TimeSpan.Zero);
        }

        public void Advance(TimeSpan duration)
        {
            Interlocked.Add(ref utcTicks, duration.Ticks);
        }
    }
}
