using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class TkgmOperationsTests
{
    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-" + Guid.NewGuid())
            .Options;
        return new BusinessContext(options);
    }

    [Fact]
    public async Task DistrictsAsync_UsesExpectedRelativePath()
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("districts");
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(100_000, 900_000);
        var result = await operations.DistrictsAsync(id);
        Assert.Equal("districts", result);
        Assert.Equal(new[] { "/idariYapi/ilceListe/" + id }, transport.Paths);
    }

    [Fact]
    public async Task NbhoodsAsync_UsesExpectedRelativePath()
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("neighbourhoods");
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(900_001, 1_800_000);
        var result = await operations.NbhoodsAsync(id);
        Assert.Equal("neighbourhoods", result);
        Assert.Equal(new[] { "/idariYapi/mahalleListe/" + id }, transport.Paths);
    }

    [Fact]
    public async Task ParcelAsync_UsesNeighbourhoodBlockAndParcel_NotDistrictInPath()
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("parcel");
        using var operations = new GisTkgmOperations(context, transport);
        var result = await operations.ParcelAsync(6, 42, 101, 7);
        Assert.Equal("parcel", result);
        Assert.Equal(new[] { "/parsel/42/101/7" }, transport.Paths);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public async Task DistrictsAsync_RejectsNonPositiveIdentifiersWithoutNetwork(int id)
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("unused");
        using var operations = new GisTkgmOperations(context, transport);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => operations.DistrictsAsync(id));
        Assert.Empty(transport.Paths);
    }

    [Theory]
    [InlineData(0, 1, 1, 1)]
    [InlineData(1, 0, 1, 1)]
    [InlineData(1, 1, 0, 1)]
    [InlineData(1, 1, 1, 0)]
    [InlineData(-1, 1, 1, 1)]
    public async Task ParcelAsync_RejectsInvalidIdentifiersWithoutNetwork(int districtId, int neighbourhoodId, int block, int parcel)
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("unused");
        using var operations = new GisTkgmOperations(context, transport);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => operations.ParcelAsync(districtId, neighbourhoodId, block, parcel));
        Assert.Empty(transport.Paths);
    }

    [Fact]
    public async Task CancellationBeforeDistrictRequest_DoesNotTouchTransport()
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("unused");
        using var operations = new GisTkgmOperations(context, transport);
        using var source = new CancellationTokenSource();
        source.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operations.DistrictsAsync(Random.Shared.Next(2_000_000, 2_900_000), source.Token));
        Assert.Empty(transport.Paths);
    }

    [Fact]
    public async Task CancellationBeforeParcelRequest_DoesNotTouchTransport()
    {
        using var context = CreateContext();
        var transport = new RecordingTransport("unused");
        using var operations = new GisTkgmOperations(context, transport);
        using var source = new CancellationTokenSource();
        source.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operations.ParcelAsync(1, 2, 3, 4, source.Token));
        Assert.Empty(transport.Paths);
    }

    [Fact]
    public async Task TransportCancellation_PropagatesToCaller()
    {
        using var context = CreateContext();
        var transport = new CancelingTransport();
        using var operations = new GisTkgmOperations(context, transport);
        using var source = new CancellationTokenSource();
        var task = operations.ParcelAsync(1, 2, 3, 4, source.Token);
        source.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
    }

    [Fact]
    public async Task FailedDistrictRequest_IsNotPublishedIntoCache()
    {
        using var context = CreateContext();
        var id = Random.Shared.Next(3_000_000, 3_900_000);
        var transport = new FailOnceTransport("recovered");
        using var operations = new GisTkgmOperations(context, transport);
        await Assert.ThrowsAsync<InvalidOperationException>(() => operations.DistrictsAsync(id));
        var recovered = await operations.DistrictsAsync(id);
        Assert.Equal("recovered", recovered);
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task SuccessfulDistrictRequest_IsReusedFromCache()
    {
        using var context = CreateContext();
        var id = Random.Shared.Next(4_000_000, 4_900_000);
        var transport = new RecordingTransport("stable");
        using var operations = new GisTkgmOperations(context, transport);
        var first = await operations.DistrictsAsync(id);
        var second = await operations.DistrictsAsync(id);
        Assert.Equal("stable", first);
        Assert.Equal(first, second);
        Assert.Single(transport.Paths);
    }

    [Fact]
    public async Task SuccessfulNeighbourhoodRequest_IsReusedFromCache()
    {
        using var context = CreateContext();
        var id = Random.Shared.Next(5_000_000, 5_900_000);
        var transport = new RecordingTransport("stable-neighbourhood");
        using var operations = new GisTkgmOperations(context, transport);
        var first = await operations.NbhoodsAsync(id);
        var second = await operations.NbhoodsAsync(id);
        Assert.Equal(first, second);
        Assert.Single(transport.Paths);
    }

    [Fact]
    public async Task ParcelRequest_IsNeverCached()
    {
        using var context = CreateContext();
        var transport = new SequenceTransport("first", "second");
        using var operations = new GisTkgmOperations(context, transport);
        var first = await operations.ParcelAsync(1, 2, 3, 4);
        var second = await operations.ParcelAsync(1, 2, 3, 4);
        Assert.Equal("first", first);
        Assert.Equal("second", second);
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task InjectedTransport_IsNotDisposedByOperations()
    {
        using var context = CreateContext();
        var transport = new DisposableTransport();
        var operations = new GisTkgmOperations(context, transport);
        await operations.ParcelAsync(1, 2, 3, 4);
        operations.Dispose();
        Assert.False(transport.Disposed);
    }

    [Fact]
    public void Constructor_RejectsNullTransport()
    {
        using var context = CreateContext();
        Assert.Throws<ArgumentNullException>(() => new GisTkgmOperations(context, null!));
    }

    [Fact]
    public void Constructor_RejectsNullContext()
    {
        var transport = new RecordingTransport("unused");
        Assert.Throws<ArgumentNullException>(() => new GisTkgmOperations(null!, transport));
    }

    private sealed class RecordingTransport : ITkgmTransport
    {
        private readonly string response;
        public List<string> Paths { get; } = new();
        public RecordingTransport(string response) => this.response = response;
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Paths.Add(relativePath);
            return Task.FromResult(response);
        }
    }

    private sealed class FailOnceTransport : ITkgmTransport
    {
        private readonly string response;
        public int CallCount { get; private set; }
        public FailOnceTransport(string response) => this.response = response;
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            CallCount++;
            if (CallCount == 1) throw new InvalidOperationException("simulated upstream failure");
            return Task.FromResult(response);
        }
    }

    private sealed class CancelingTransport : ITkgmTransport
    {
        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return "unreachable";
        }
    }

    private sealed class SequenceTransport : ITkgmTransport
    {
        private readonly ConcurrentQueue<string> responses;
        public int CallCount { get; private set; }
        public SequenceTransport(params string[] responses) => responses = new ConcurrentQueue<string>(responses);
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            CallCount++;
            if (!responses.TryDequeue(out var response)) throw new InvalidOperationException("No test response remains.");
            return Task.FromResult(response);
        }
    }

    private sealed class DisposableTransport : ITkgmTransport, IDisposable
    {
        public bool Disposed { get; private set; }
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken) => Task.FromResult("ok");
        public void Dispose() => Disposed = true;
    }
}
