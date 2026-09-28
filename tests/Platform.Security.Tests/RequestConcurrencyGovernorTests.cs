using Api.Core.Platform;
using Api.Core.Platform.Governance;
using System;
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
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 100;
        options.Governance.Concurrency.MaxConcurrentPerClient = 100;
        options.Governance.Concurrency.MaxTrackedClients = 16;
        options.Governance.Concurrency.CleanupInterval = 100000;
        var governor = new RequestConcurrencyGovernor(options);
        var leases = new List<RequestConcurrencyLease>();

        try
        {
            for (var index = 0; index < 40; index++)
            {
                leases.Add(governor.TryAcquire("client:" + index));
            }

            Assert.True(governor.TrackedClients <= 16);
            Assert.True(governor.GetSnapshot().TrackedClients <= governor.GetSnapshot().MaxTrackedClients);
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
    public void ConcurrentUniquePartitions_CannotRacePastTrackedClientBound()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 512;
        options.Governance.Concurrency.MaxConcurrentPerClient = 512;
        options.Governance.Concurrency.MaxTrackedClients = 16;
        options.Governance.Concurrency.CleanupInterval = 100000;
        var governor = new RequestConcurrencyGovernor(options);

        using var start = new ManualResetEventSlim(initialState: false);
        var tasks = Enumerable.Range(0, 256).Select(index => Task.Run(() =>
        {
            start.Wait();
            return governor.TryAcquire("client:parallel:" + index);
        })).ToArray();

        start.Set();
        Task.WaitAll(tasks);

        try
        {
            var acquired = tasks.Count(task => task.Result.IsAcquired);
            Assert.Equal(256, acquired);
            Assert.Equal(acquired, governor.ActiveRequests);
            Assert.True(
                governor.TrackedClients <= 16,
                $"Tracked client cardinality exceeded the configured bound: {governor.TrackedClients}");
            Assert.True(governor.GetSnapshot().TrackedClients <= governor.GetSnapshot().MaxTrackedClients);
        }
        finally
        {
            foreach (var task in tasks)
            {
                task.Result.Dispose();
            }
        }

        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public void ConcurrentKnownPartition_ReusesExistingStateWithoutRegistrationGrowth()
    {
        var governor = CreateGovernor(global: 256, perClient: 256);
        using var start = new ManualResetEventSlim(initialState: false);
        var tasks = Enumerable.Range(0, 128).Select(_ => Task.Run(() =>
        {
            start.Wait();
            return governor.TryAcquire("client:shared");
        })).ToArray();

        start.Set();
        Task.WaitAll(tasks);

        try
        {
            Assert.All(tasks, task => Assert.True(task.Result.IsAcquired));
            Assert.Equal(128, governor.ActiveRequests);
            Assert.Equal(1, governor.TrackedClients);
        }
        finally
        {
            foreach (var task in tasks)
            {
                task.Result.Dispose();
            }
        }

        Assert.Equal(0, governor.ActiveRequests);
        Assert.Equal(1, governor.TrackedClients);
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

    private static RequestConcurrencyGovernor CreateGovernor(int global, int perClient)
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = global;
        options.Governance.Concurrency.MaxConcurrentPerClient = perClient;
        options.Governance.Concurrency.MaxTrackedClients = 64;
        options.Governance.Concurrency.CleanupInterval = 64;
        return new RequestConcurrencyGovernor(options);
    }
}
