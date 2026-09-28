using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisTkgmOperationsTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public async Task DistrictsAsync_RejectsNonPositiveIdentifiers(int cityId)
    {
        await using var context = CreateContext();
        var transport = new RecordingTransport(_ => Task.FromResult("[]"));
        using var operations = new GisTkgmOperations(context, transport);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => operations.DistrictsAsync(cityId));
        Assert.Equal(0, transport.CallCount);
    }

    [Theory]
    [InlineData(0, 1, 1, 1)]
    [InlineData(1, 0, 1, 1)]
    [InlineData(1, 1, 0, 1)]
    [InlineData(1, 1, 1, 0)]
    [InlineData(-1, 1, 1, 1)]
    public async Task ParcelAsync_RejectsNonPositiveIdentifiers(int districtId, int neighbourhoodId, int block, int parcel)
    {
        await using var context = CreateContext();
        var transport = new RecordingTransport(_ => Task.FromResult("{}"));
        using var operations = new GisTkgmOperations(context, transport);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => operations.ParcelAsync(districtId, neighbourhoodId, block, parcel));
        Assert.Equal(0, transport.CallCount);
    }

    [Fact]
    public async Task ParcelAsync_UsesCanonicalRelativePath()
    {
        await using var context = CreateContext();
        var transport = new RecordingTransport(_ => Task.FromResult("{\"ok\":true}"));
        using var operations = new GisTkgmOperations(context, transport);
        var result = await operations.ParcelAsync(34, 9001, 123, 45);
        Assert.Equal("{\"ok\":true}", result);
        Assert.Equal(new[] { "/parsel/9001/123/45" }, transport.Paths);
    }

    [Fact]
    public async Task DistrictsAsync_ReusesFreshAdministrativeCache()
    {
        await using var context = CreateContext();
        var transport = new RecordingTransport(_ => Task.FromResult("[{\"id\":1}]"));
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        var first = await operations.DistrictsAsync(key);
        var second = await operations.DistrictsAsync(key);
        Assert.Equal(first, second);
        Assert.Equal(1, transport.CallCount);
        Assert.Equal(new[] { "/idariYapi/ilceListe/" + key }, transport.Paths);
    }

    [Fact]
    public async Task NbhoodsAsync_ReusesFreshAdministrativeCache()
    {
        await using var context = CreateContext();
        var transport = new RecordingTransport(_ => Task.FromResult("[{\"id\":2}]"));
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        var first = await operations.NbhoodsAsync(key);
        var second = await operations.NbhoodsAsync(key);
        Assert.Equal(first, second);
        Assert.Equal(1, transport.CallCount);
        Assert.Equal(new[] { "/idariYapi/mahalleListe/" + key }, transport.Paths);
    }

    [Fact]
    public async Task DistrictsAsync_DeduplicatesConcurrentSameKeyRequests()
    {
        await using var context = CreateContext();
        var release = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport(_ => release.Task);
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        var requests = Enumerable.Range(0, 64).Select(_ => operations.DistrictsAsync(key)).ToArray();
        await transport.WaitForCallAsync();
        Assert.Equal(1, transport.CallCount);
        release.SetResult("[{\"id\":3}]");
        var results = await Task.WhenAll(requests);
        Assert.All(results, value => Assert.Equal("[{\"id\":3}]", value));
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task DistrictsAsync_OneCancelledSubscriber_DoesNotCancelSharedWorkForOthers()
    {
        await using var context = CreateContext();
        var release = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new RecordingTransport(_ => release.Task);
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        using var cancellation = new CancellationTokenSource();
        var cancelledSubscriber = operations.DistrictsAsync(key, cancellation.Token);
        var survivingSubscriber = operations.DistrictsAsync(key);
        await transport.WaitForCallAsync();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelledSubscriber);
        Assert.False(transport.LastToken.IsCancellationRequested);
        release.SetResult("[{\"id\":4}]");
        Assert.Equal("[{\"id\":4}]", await survivingSubscriber);
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task DistrictsAsync_AllCancelledSubscribers_CancelSharedUpstreamWork()
    {
        await using var context = CreateContext();
        var transport = new CancellationAwareTransport();
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        using var firstCancellation = new CancellationTokenSource();
        using var secondCancellation = new CancellationTokenSource();
        var first = operations.DistrictsAsync(key, firstCancellation.Token);
        var second = operations.DistrictsAsync(key, secondCancellation.Token);
        await transport.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        firstCancellation.Cancel();
        secondCancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second);
        await transport.Cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task DistrictsAsync_FailedFlight_IsNotCachedAndCanRetry()
    {
        await using var context = CreateContext();
        var attempt = 0;
        var transport = new RecordingTransport(_ =>
        {
            if (Interlocked.Increment(ref attempt) == 1) throw new InvalidOperationException("simulated upstream failure");
            return Task.FromResult("[{\"id\":5}]");
        });
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        await Assert.ThrowsAsync<InvalidOperationException>(() => operations.DistrictsAsync(key));
        Assert.Equal("[{\"id\":5}]", await operations.DistrictsAsync(key));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task DistrictsAsync_OversizedResponse_IsReturnedButNotCached()
    {
        await using var context = CreateContext();
        const int documentedEntryBudgetBytes = 1 * 1024 * 1024;
        var payload = new string('x', documentedEntryBudgetBytes + 1);
        var transport = new RecordingTransport(_ => Task.FromResult(payload));
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        Assert.Equal(payload, await operations.DistrictsAsync(key));
        Assert.Equal(payload, await operations.DistrictsAsync(key));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task DistrictsAsync_EmptyResponse_IsRejectedAndNotCached()
    {
        await using var context = CreateContext();
        var transport = new RecordingTransport(_ => Task.FromResult(string.Empty));
        using var operations = new GisTkgmOperations(context, transport);
        var key = UniquePositiveKey();
        await Assert.ThrowsAsync<InvalidOperationException>(() => operations.DistrictsAsync(key));
        await Assert.ThrowsAsync<InvalidOperationException>(() => operations.DistrictsAsync(key));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task ParcelAsync_DoesNotUseAdministrativeCache()
    {
        await using var context = CreateContext();
        var sequence = 0;
        var transport = new RecordingTransport(_ => Task.FromResult("{\"sequence\":" + Interlocked.Increment(ref sequence) + "}"));
        using var operations = new GisTkgmOperations(context, transport);
        var first = await operations.ParcelAsync(1, 2, 3, 4);
        var second = await operations.ParcelAsync(1, 2, 3, 4);
        Assert.NotEqual(first, second);
        Assert.Equal(2, transport.CallCount);
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>().UseInMemoryDatabase("tkgm-tests-" + Guid.NewGuid().ToString("N")).Options;
        return new BusinessContext(options);
    }

    private static int UniquePositiveKey()
    {
        var value = Interlocked.Increment(ref nextKey);
        return value > 0 ? value : 1;
    }

    private static int nextKey = 100_000;

    private sealed class RecordingTransport : ITkgmTransport
    {
        private readonly Func<CancellationToken, Task<string>> handler;
        private readonly ConcurrentQueue<string> paths = new();
        private readonly TaskCompletionSource<bool> firstCall = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int callCount;
        public RecordingTransport(Func<CancellationToken, Task<string>> handler) => this.handler = handler;
        public int CallCount => Volatile.Read(ref callCount);
        public string[] Paths => paths.ToArray();
        public CancellationToken LastToken { get; private set; }
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            paths.Enqueue(relativePath);
            LastToken = cancellationToken;
            Interlocked.Increment(ref callCount);
            firstCall.TrySetResult(true);
            return handler(cancellationToken);
        }
        public Task WaitForCallAsync() => firstCall.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private sealed class CancellationAwareTransport : ITkgmTransport
    {
        private int callCount;
        public int CallCount => Volatile.Read(ref callCount);
        public TaskCompletionSource<bool> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> Cancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref callCount);
            Started.TrySetResult(true);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return "unreachable";
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Cancelled.TrySetResult(true);
                throw;
            }
        }
    }
}
