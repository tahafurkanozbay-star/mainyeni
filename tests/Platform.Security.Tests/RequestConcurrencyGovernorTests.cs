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

public sealed class RequestConcurrencyGovernorTests
{
    [Fact]
    public void TryAcquire_TracksAndReleasesGlobalConcurrency()
    {
        var governor = CreateGovernor(global: 2, perClient: 2);
        using var lease = governor.TryAcquire("client:a");
        Assert.True(lease.IsAcquired);
        Assert.Equal(1, governor.ActiveRequests);
        Assert.Equal(1, governor.GetSnapshot().ActiveRequests);
        lease.Dispose();
        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public void TryAcquire_RejectsAboveGlobalLimit()
    {
        var governor = CreateGovernor(global: 1, perClient: 2);
        using var first = governor.TryAcquire("client:a");
        using var second = governor.TryAcquire("client:b");
        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.GlobalLimit, second.Rejection);
        Assert.Equal(1, governor.ActiveRequests);
    }

    [Fact]
    public void TryAcquire_RejectsAbovePerClientLimit()
    {
        var governor = CreateGovernor(global: 10, perClient: 1);
        using var first = governor.TryAcquire("client:a");
        using var second = governor.TryAcquire("client:a");
        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, second.Rejection);
        Assert.Equal(1, governor.ActiveRequests);
    }

    [Fact]
    public void ReleasingLease_RestoresPerClientCapacity()
    {
        var governor = CreateGovernor(global: 2, perClient: 1);
        var first = governor.TryAcquire("client:a");
        Assert.True(first.IsAcquired);
        first.Dispose();
        using var second = governor.TryAcquire("client:a");
        Assert.True(second.IsAcquired);
    }

    [Fact]
    public void Dispose_IsIdempotent()
    {
        var governor = CreateGovernor(global: 1, perClient: 1);
        var lease = governor.TryAcquire("client:a");
        lease.Dispose();
        lease.Dispose();
        lease.Dispose();
        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public void RejectedLease_DisposeDoesNotChangeCounters()
    {
        var governor = CreateGovernor(global: 1, perClient: 1);
        using var first = governor.TryAcquire("client:a");
        var rejected = governor.TryAcquire("client:b");
        rejected.Dispose();
        Assert.Equal(1, governor.ActiveRequests);
    }

    [Fact]
    public void DifferentClients_HaveIndependentClientBudgets()
    {
        var governor = CreateGovernor(global: 4, perClient: 1);
        using var first = governor.TryAcquire("client:a");
        using var second = governor.TryAcquire("client:b");
        Assert.True(first.IsAcquired);
        Assert.True(second.IsAcquired);
        Assert.Equal(2, governor.ActiveRequests);
    }

    [Fact]
    public void NullAndBlankKeys_UseBoundedUnknownPartition()
    {
        var governor = CreateGovernor(global: 4, perClient: 1);
        using var first = governor.TryAcquire(null!);
        using var second = governor.TryAcquire("   ");
        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, second.Rejection);
    }

    [Fact]
    public void LongKeys_AreNormalizedWithoutBreakingCapacity()
    {
        var governor = CreateGovernor(global: 4, perClient: 1);
        var prefix = new string('a', 160);
        using var first = governor.TryAcquire(prefix + "one");
        using var second = governor.TryAcquire(prefix + "two");
        Assert.True(first.IsAcquired);
        Assert.False(second.IsAcquired);
        Assert.Equal(RequestConcurrencyRejection.ClientLimit, second.Rejection);
    }

    [Fact]
    public void TrackedClientCardinality_IsStrictlyBoundedIncludingOverflowPartition()
    {
        var governor = CreateGovernor(global: 100, perClient: 100, maxTrackedClients: 16, cleanupInterval: 100000);
        var leases = new List<RequestConcurrencyLease>();
        try
        {
            for (var index = 0; index < 40; index++)
            {
                leases.Add(governor.TryAcquire("client:" + index));
            }
            Assert.True(governor.TrackedClients <= 16);
        }
        finally
        {
            foreach (var lease in leases)
            {
                lease.Dispose();
            }
        }
    }

    [Fact]
    public async Task ConcurrentUniqueClients_CannotRacePastTrackedClientBudget()
    {
        const int maxTrackedClients = 16;
        const int contenders = 256;
        var governor = CreateGovernor(
            global: contenders,
            perClient: contenders,
            maxTrackedClients: maxTrackedClients,
            cleanupInterval: 100000);
        using var start = new ManualResetEventSlim(false);
        var leases = new ConcurrentBag<RequestConcurrencyLease>();
        var tasks = Enumerable.Range(0, contenders)
            .Select(index => Task.Run(() =>
            {
                start.Wait();
                leases.Add(governor.TryAcquire("parallel-client:" + index));
            }))
            .ToArray();

        start.Set();
        await Task.WhenAll(tasks);

        try
        {
            Assert.Equal(contenders, governor.ActiveRequests);
            Assert.True(governor.TrackedClients <= maxTrackedClients);
            Assert.True(governor.GetSnapshot().TrackedClients <= maxTrackedClients);
        }
        finally
        {
            foreach (var lease in leases)
            {
                lease.Dispose();
            }
        }
        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public async Task ConcurrentSameClient_NeverExceedsPerClientBudget()
    {
        const int contenders = 128;
        const int perClient = 7;
        var governor = CreateGovernor(global: contenders, perClient: perClient, cleanupInterval: 1);
        using var start = new ManualResetEventSlim(false);
        var leases = new ConcurrentBag<RequestConcurrencyLease>();
        var tasks = Enumerable.Range(0, contenders)
            .Select(_ => Task.Run(() =>
            {
                start.Wait();
                leases.Add(governor.TryAcquire("client:shared"));
            }))
            .ToArray();

        start.Set();
        await Task.WhenAll(tasks);

        try
        {
            Assert.Equal(perClient, leases.Count(static lease => lease.IsAcquired));
            Assert.Equal(perClient, governor.ActiveRequests);
            Assert.All(
                leases.Where(static lease => !lease.IsAcquired),
                static lease => Assert.Equal(RequestConcurrencyRejection.ClientLimit, lease.Rejection));
        }
        finally
        {
            foreach (var lease in leases)
            {
                lease.Dispose();
            }
        }
        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public async Task CleanupPressure_DoesNotDetachActiveClientState()
    {
        const int iterations = 200;
        const int maxTrackedClients = 16;
        var governor = CreateGovernor(
            global: 32,
            perClient: 1,
            maxTrackedClients: maxTrackedClients,
            cleanupInterval: 1);

        for (var iteration = 0; iteration < iterations; iteration++)
        {
            using var held = governor.TryAcquire("client:stable");
            Assert.True(held.IsAcquired);

            var probes = Enumerable.Range(0, 24)
                .Select(index => Task.Run(() =>
                {
                    using var noise = governor.TryAcquire("noise:" + iteration + ":" + index);
                    using var competing = governor.TryAcquire("client:stable");
                    return competing.IsAcquired;
                }))
                .ToArray();

            var results = await Task.WhenAll(probes);
            Assert.DoesNotContain(true, results);
        }

        Assert.Equal(0, governor.ActiveRequests);
        Assert.True(governor.TrackedClients <= maxTrackedClients);
    }

    [Fact]
    public void Snapshot_ExposesOnlyAggregateCapacityFacts()
    {
        var governor = CreateGovernor(global: 20, perClient: 5);
        using var lease = governor.TryAcquire("sensitive-user-id");
        var snapshot = governor.GetSnapshot();
        Assert.Equal(1, snapshot.ActiveRequests);
        Assert.Equal(20, snapshot.MaxConcurrentRequests);
        Assert.Equal(5, snapshot.MaxConcurrentPerClient);
        Assert.True(snapshot.TrackedClients >= 1);
    }

    [Fact]
    public void RepeatedAcquireRelease_DoesNotLeakActiveCounter()
    {
        var governor = CreateGovernor(global: 2, perClient: 2);
        for (var index = 0; index < 1000; index++)
        {
            using var lease = governor.TryAcquire("client:a");
            Assert.True(lease.IsAcquired);
        }
        Assert.Equal(0, governor.ActiveRequests);
    }

    private static RequestConcurrencyGovernor CreateGovernor(
        int global,
        int perClient,
        int maxTrackedClients = 64,
        int cleanupInterval = 64)
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = global;
        options.Governance.Concurrency.MaxConcurrentPerClient = perClient;
        options.Governance.Concurrency.MaxTrackedClients = maxTrackedClients;
        options.Governance.Concurrency.CleanupInterval = cleanupInterval;
        return new RequestConcurrencyGovernor(options);
    }
}