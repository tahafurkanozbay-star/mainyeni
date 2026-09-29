using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

[Collection(TkgmAdministrativeCacheCollection.Name)]
public sealed class TkgmCacheCapacityTests
{
    private const int CacheCapacity = 512;
    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>().UseInMemoryDatabase("tkgm-capacity-" + Guid.NewGuid()).Options;
        return new BusinessContext(options);
    }

    [Fact]
    public async Task DistrictCache_EvictsOldestEntryInsteadOfClearingHotSet()
    {
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var transport = new PathEchoTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        var firstId = 30_000_000;
        for (var offset = 0; offset < CacheCapacity; offset++)
        {
            var id = firstId + offset;
            Assert.Equal(ResponseForDistrict(id), await operations.DistrictsAsync(id));
            clock.Advance(TimeSpan.FromMilliseconds(1));
        }
        var retainedId = firstId + 1;
        Assert.Equal(ResponseForDistrict(retainedId), await operations.DistrictsAsync(retainedId));
        Assert.Equal(1, transport.CallsFor(DistrictPath(retainedId)));
        var overflowId = firstId + CacheCapacity;
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(ResponseForDistrict(overflowId), await operations.DistrictsAsync(overflowId));
        Assert.Equal(ResponseForDistrict(retainedId), await operations.DistrictsAsync(retainedId));
        Assert.Equal(1, transport.CallsFor(DistrictPath(retainedId)));
        Assert.Equal(ResponseForDistrict(firstId), await operations.DistrictsAsync(firstId));
        Assert.Equal(2, transport.CallsFor(DistrictPath(firstId)));
    }

    [Fact]
    public async Task DistrictCache_PrunesExpiredEntriesBeforeCapacityEviction()
    {
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2031, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var transport = new PathEchoTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        var firstId = 31_000_000;
        for (var offset = 0; offset < CacheCapacity; offset++) await operations.DistrictsAsync(firstId + offset);
        clock.Advance(TimeSpan.FromMinutes(15));
        var newId = firstId + CacheCapacity;
        await operations.DistrictsAsync(newId);
        await operations.DistrictsAsync(newId);
        Assert.Equal(1, transport.CallsFor(DistrictPath(newId)));
        await operations.DistrictsAsync(firstId);
        Assert.Equal(2, transport.CallsFor(DistrictPath(firstId)));
        Assert.Equal(1, transport.CallsFor(DistrictPath(newId)));
    }

    [Fact]
    public async Task NeighbourhoodCache_UsesIndependentBoundedCapacity()
    {
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2032, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var transport = new PathEchoTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        var firstId = 32_000_000;
        for (var offset = 0; offset <= CacheCapacity; offset++)
        {
            await operations.NbhoodsAsync(firstId + offset);
            clock.Advance(TimeSpan.FromMilliseconds(1));
        }
        var retainedId = firstId + 1;
        await operations.NbhoodsAsync(retainedId);
        Assert.Equal(1, transport.CallsFor(NeighbourhoodPath(retainedId)));
        await operations.NbhoodsAsync(firstId);
        Assert.Equal(2, transport.CallsFor(NeighbourhoodPath(firstId)));
    }

    [Fact]
    public async Task CapacityAdmission_DoesNotAffectParcelNonCachingContract()
    {
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2033, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var transport = new PathEchoTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        for (var offset = 0; offset <= CacheCapacity; offset++) await operations.DistrictsAsync(33_000_000 + offset);
        const string parcelPath = "/parsel/42/101/7";
        Assert.Equal(parcelPath, await operations.ParcelAsync(6, 42, 101, 7));
        Assert.Equal(parcelPath, await operations.ParcelAsync(6, 42, 101, 7));
        Assert.Equal(2, transport.CallsFor(parcelPath));
    }

    private static string DistrictPath(int id) => "/idariYapi/ilceListe/" + id;
    private static string NeighbourhoodPath(int id) => "/idariYapi/mahalleListe/" + id;
    private static string ResponseForDistrict(int id) => DistrictPath(id);

    private sealed class PathEchoTransport : ITkgmTransport
    {
        private readonly ConcurrentDictionary<string, int> calls = new(StringComparer.Ordinal);
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            calls.AddOrUpdate(relativePath, 1, static (_, count) => checked(count + 1));
            return Task.FromResult(relativePath);
        }
        public int CallsFor(string path) => calls.TryGetValue(path, out var count) ? count : 0;
    }

    private sealed class SteppingTimeProvider : TimeProvider
    {
        private DateTimeOffset utcNow;
        public SteppingTimeProvider(DateTimeOffset utcNow) => this.utcNow = utcNow;
        public override DateTimeOffset GetUtcNow() => utcNow;
        public void Advance(TimeSpan duration) => utcNow += duration;
    }
}
