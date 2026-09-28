using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

[Collection(TkgmAdministrativeCacheCollection.Name)]
public sealed class TkgmSingleFlightTests
{
    public TkgmSingleFlightTests()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
    }

    [Fact]
    public async Task ConcurrentDistrictMissesForSameKey_ShareOneUpstreamRequest()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 1, response: "districts");
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(20_000_000, 20_900_000);

        var requests = Enumerable.Range(0, 32)
            .Select(_ => operations.DistrictsAsync(id))
            .ToArray();

        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, transport.CallCount);

        transport.Release();
        var results = await Task.WhenAll(requests);

        Assert.All(results, value => Assert.Equal("districts", value));
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task ConcurrentNeighbourhoodMissesForSameKey_ShareOneUpstreamRequest()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 1, response: "neighbourhoods");
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(21_000_000, 21_900_000);

        var requests = Enumerable.Range(0, 24)
            .Select(_ => operations.NbhoodsAsync(id))
            .ToArray();

        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, transport.CallCount);

        transport.Release();
        var results = await Task.WhenAll(requests);

        Assert.All(results, value => Assert.Equal("neighbourhoods", value));
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task DifferentDistrictKeys_DoNotShareSingleFlight()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 2, response: "district");
        using var operations = new GisTkgmOperations(context, transport);
        var firstId = Random.Shared.Next(22_000_000, 22_400_000);
        var secondId = firstId + 500_000;

        var first = operations.DistrictsAsync(firstId);
        var second = operations.DistrictsAsync(secondId);

        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, transport.CallCount);

        transport.Release();
        Assert.Equal("district", await first);
        Assert.Equal("district", await second);
    }

    [Fact]
    public async Task CancellingOneWaiter_DoesNotCancelSharedUpstreamForRemainingWaiter()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 1, response: "shared");
        using var operations = new GisTkgmOperations(context, transport);
        using var cancelledCaller = new CancellationTokenSource();
        var id = Random.Shared.Next(23_000_000, 23_900_000);

        var first = operations.DistrictsAsync(id, cancelledCaller.Token);
        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        var second = operations.DistrictsAsync(id);
        await Task.Yield();

        cancelledCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.False(transport.CancellationObserved.IsCompleted);

        transport.Release();
        Assert.Equal("shared", await second);
        Assert.False(transport.CancellationObserved.IsCompleted);
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task CancellingAllWaiters_CancelsSharedUpstreamRequest()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 1, response: "unused");
        using var operations = new GisTkgmOperations(context, transport);
        using var firstCaller = new CancellationTokenSource();
        using var secondCaller = new CancellationTokenSource();
        var id = Random.Shared.Next(24_000_000, 24_900_000);

        var first = operations.DistrictsAsync(id, firstCaller.Token);
        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        var second = operations.DistrictsAsync(id, secondCaller.Token);
        await Task.Yield();

        firstCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.False(transport.CancellationObserved.IsCompleted);

        secondCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second);
        await transport.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task FaultedSharedRequest_IsRemovedAndCanBeRetried()
    {
        using var context = CreateContext();
        var transport = new FailOnceBlockingTransport("recovered");
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(25_000_000, 25_900_000);

        var firstWave = Enumerable.Range(0, 12)
            .Select(_ => operations.DistrictsAsync(id))
            .ToArray();

        await transport.FirstCallStarted.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, transport.CallCount);
        transport.ReleaseFailure();

        foreach (var request in firstWave)
            await Assert.ThrowsAsync<InvalidOperationException>(() => request);

        var recovered = await operations.DistrictsAsync(id);

        Assert.Equal("recovered", recovered);
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task SuccessfulSharedRequest_IsPublishedBeforeFlightIsRemoved()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 1, response: "cached");
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(26_000_000, 26_900_000);

        var firstWave = Enumerable.Range(0, 8)
            .Select(_ => operations.DistrictsAsync(id))
            .ToArray();

        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        transport.Release();
        await Task.WhenAll(firstWave);

        var rejectingTransport = new RejectingTransport();
        using var secondOperations = new GisTkgmOperations(context, rejectingTransport);
        var cached = await secondOperations.DistrictsAsync(id);

        Assert.Equal("cached", cached);
        Assert.Equal(0, rejectingTransport.CallCount);
    }

    [Fact]
    public async Task ParcelRequests_AreNotSingleFlightOrCached()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 2, response: "parcel");
        using var operations = new GisTkgmOperations(context, transport);

        var first = operations.ParcelAsync(6, 42, 101, 7);
        var second = operations.ParcelAsync(6, 42, 101, 7);

        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, transport.CallCount);

        transport.Release();
        Assert.Equal("parcel", await first);
        Assert.Equal("parcel", await second);
    }

    [Fact]
    public async Task CancelledFlight_DoesNotPublishAdministrativeCacheEntry()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport(expectedCalls: 1, response: "should-not-cache");
        using var operations = new GisTkgmOperations(context, transport);
        using var caller = new CancellationTokenSource();
        var id = Random.Shared.Next(27_000_000, 27_900_000);

        var request = operations.NbhoodsAsync(id, caller.Token);
        await transport.AllExpectedCallsStarted.WaitAsync(TimeSpan.FromSeconds(5));
        caller.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        await transport.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));

        var recoveryTransport = new RecordingTransport("fresh");
        using var recovery = new GisTkgmOperations(context, recoveryTransport);
        Assert.Equal("fresh", await recovery.NbhoodsAsync(id));
        Assert.Equal(1, recoveryTransport.CallCount);
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-single-flight-" + Guid.NewGuid())
            .Options;
        return new BusinessContext(options);
    }

    private sealed class BlockingTransport : ITkgmTransport
    {
        private readonly int expectedCalls;
        private readonly string response;
        private readonly TaskCompletionSource<bool> allStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> cancellationObserved =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int callCount;

        public BlockingTransport(int expectedCalls, string response)
        {
            this.expectedCalls = expectedCalls;
            this.response = response;
        }

        public int CallCount => Volatile.Read(ref callCount);
        public Task AllExpectedCallsStarted => allStarted.Task;
        public Task CancellationObserved => cancellationObserved.Task;

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            var current = Interlocked.Increment(ref callCount);
            if (current >= expectedCalls) allStarted.TrySetResult(true);
            using var registration = cancellationToken.Register(
                () => cancellationObserved.TrySetResult(true));
            await release.Task.WaitAsync(cancellationToken);
            return response;
        }

        public void Release() => release.TrySetResult(true);
    }

    private sealed class FailOnceBlockingTransport : ITkgmTransport
    {
        private readonly string recovery;
        private readonly TaskCompletionSource<bool> firstStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> releaseFailure =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int callCount;

        public FailOnceBlockingTransport(string recovery) => this.recovery = recovery;

        public int CallCount => Volatile.Read(ref callCount);
        public Task FirstCallStarted => firstStarted.Task;

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            var current = Interlocked.Increment(ref callCount);
            if (current == 1)
            {
                firstStarted.TrySetResult(true);
                await releaseFailure.Task.WaitAsync(cancellationToken);
                throw new InvalidOperationException("simulated TKGM failure");
            }

            return recovery;
        }

        public void ReleaseFailure() => releaseFailure.TrySetResult(true);
    }

    private sealed class RejectingTransport : ITkgmTransport
    {
        public int CallCount { get; private set; }

        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            CallCount++;
            throw new InvalidOperationException("Cache hit should bypass the transport.");
        }
    }

    private sealed class RecordingTransport : ITkgmTransport
    {
        private readonly string response;
        public int CallCount { get; private set; }

        public RecordingTransport(string response) => this.response = response;

        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CallCount++;
            return Task.FromResult(response);
        }
    }
}
