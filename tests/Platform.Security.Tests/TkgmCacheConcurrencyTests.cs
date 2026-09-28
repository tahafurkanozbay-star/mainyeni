using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

[Collection(TkgmAdministrativeCacheCollection.Name)]
public sealed class TkgmCacheConcurrencyTests
{
    private const int ConcurrentAdmissionCount = 640;

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-concurrency-" + Guid.NewGuid())
            .Options;

        return new BusinessContext(options);
    }

    [Fact]
    public async Task DistrictCache_ConcurrentUniqueAdmissions_NeverExceedCapacity()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var transport = new BarrierEchoTransport(ConcurrentAdmissionCount);
        using var operations = new GisTkgmOperations(context, transport);

        var tasks = Enumerable.Range(40_000_000, ConcurrentAdmissionCount)
            .Select(id => operations.DistrictsAsync(id))
            .ToArray();

        await transport.WaitUntilAllStartedAsync();
        transport.Release();
        await Task.WhenAll(tasks);

        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(GisTkgmOperations.MaxAdministrativeCacheEntries, counts.Districts);
        Assert.Equal(0, counts.Neighbourhoods);
        Assert.Equal(ConcurrentAdmissionCount, transport.TotalCalls);
    }

    [Fact]
    public async Task NeighbourhoodCache_ConcurrentUniqueAdmissions_NeverExceedCapacity()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var transport = new BarrierEchoTransport(ConcurrentAdmissionCount);
        using var operations = new GisTkgmOperations(context, transport);

        var tasks = Enumerable.Range(41_000_000, ConcurrentAdmissionCount)
            .Select(id => operations.NbhoodsAsync(id))
            .ToArray();

        await transport.WaitUntilAllStartedAsync();
        transport.Release();
        await Task.WhenAll(tasks);

        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(0, counts.Districts);
        Assert.Equal(GisTkgmOperations.MaxAdministrativeCacheEntries, counts.Neighbourhoods);
        Assert.Equal(ConcurrentAdmissionCount, transport.TotalCalls);
    }

    [Fact]
    public async Task ConcurrentAdmission_PreservesIndependentCacheBounds()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var expectedCalls = ConcurrentAdmissionCount * 2;
        var transport = new BarrierEchoTransport(expectedCalls);
        using var operations = new GisTkgmOperations(context, transport);

        var districtTasks = Enumerable.Range(42_000_000, ConcurrentAdmissionCount)
            .Select(id => operations.DistrictsAsync(id));
        var neighbourhoodTasks = Enumerable.Range(43_000_000, ConcurrentAdmissionCount)
            .Select(id => operations.NbhoodsAsync(id));
        var tasks = districtTasks.Concat(neighbourhoodTasks).ToArray();

        await transport.WaitUntilAllStartedAsync();
        transport.Release();
        await Task.WhenAll(tasks);

        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(GisTkgmOperations.MaxAdministrativeCacheEntries, counts.Districts);
        Assert.Equal(GisTkgmOperations.MaxAdministrativeCacheEntries, counts.Neighbourhoods);
        Assert.Equal(expectedCalls, transport.TotalCalls);
    }

    [Fact]
    public async Task ConcurrentRefreshAndOverflow_PreserveCapacityInvariant()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var transport = new ImmediateEchoTransport();
        using var operations = new GisTkgmOperations(context, transport);

        await Task.WhenAll(
            Enumerable.Range(44_000_000, GisTkgmOperations.MaxAdministrativeCacheEntries)
                .Select(id => operations.DistrictsAsync(id)));

        var repeated = Enumerable.Range(0, 256)
            .Select(_ => operations.DistrictsAsync(44_000_000));
        var overflow = Enumerable.Range(45_000_000, 256)
            .Select(id => operations.DistrictsAsync(id));

        await Task.WhenAll(repeated.Concat(overflow));

        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(GisTkgmOperations.MaxAdministrativeCacheEntries, counts.Districts);
        Assert.Equal(0, counts.Neighbourhoods);
    }

    [Fact]
    public async Task CancelledAdministrativeRequest_DoesNotPublishCacheEntry()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var transport = new CancellationBlockingTransport();
        using var operations = new GisTkgmOperations(context, transport);
        using var cancellation = new CancellationTokenSource();

        var request = operations.DistrictsAsync(46_000_000, cancellation.Token);
        await transport.Started;
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);

        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(0, counts.Districts);
        Assert.Equal(0, counts.Neighbourhoods);
    }

    [Fact]
    public async Task CancelledNeighbourhoodRequest_DoesNotPublishCacheEntry()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var transport = new CancellationBlockingTransport();
        using var operations = new GisTkgmOperations(context, transport);
        using var cancellation = new CancellationTokenSource();

        var request = operations.NbhoodsAsync(47_000_000, cancellation.Token);
        await transport.Started;
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);

        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(0, counts.Districts);
        Assert.Equal(0, counts.Neighbourhoods);
    }

    private sealed class BarrierEchoTransport : ITkgmTransport
    {
        private readonly int expectedCalls;
        private readonly TaskCompletionSource<bool> allStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int totalCalls;

        public BarrierEchoTransport(int expectedCalls)
        {
            if (expectedCalls <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(expectedCalls));
            }

            this.expectedCalls = expectedCalls;
        }

        public int TotalCalls => Volatile.Read(ref totalCalls);

        public Task WaitUntilAllStartedAsync() => allStarted.Task;

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var calls = Interlocked.Increment(ref totalCalls);
            if (calls == expectedCalls)
            {
                allStarted.TrySetResult(true);
            }

            await release.Task.WaitAsync(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            return relativePath;
        }

        public void Release() => release.TrySetResult(true);
    }

    private sealed class ImmediateEchoTransport : ITkgmTransport
    {
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(relativePath);
        }
    }

    private sealed class CancellationBlockingTransport : ITkgmTransport
    {
        private readonly TaskCompletionSource<bool> started =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Started => started.Task;

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            started.TrySetResult(true);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return relativePath;
        }
    }
}
