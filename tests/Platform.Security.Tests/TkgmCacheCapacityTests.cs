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
        var transport = new CountingTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        for (var id = 1; id <= CacheCapacity; id++) await operations.DistrictsAsync(id);
        await operations.DistrictsAsync(CacheCapacity + 1);
        var callsBeforeHotLookup = transport.TotalCalls;
        await operations.DistrictsAsync(CacheCapacity);
        Assert.Equal(callsBeforeHotLookup, transport.TotalCalls);
        await operations.DistrictsAsync(1);
        Assert.Equal(callsBeforeHotLookup + 1, transport.TotalCalls);
        Assert.Equal(CacheCapacity, GisTkgmOperations.GetAdministrativeCacheCountsForTesting().Districts);
    }

    [Fact]
    public async Task NeighbourhoodCache_IsBoundedIndependently()
    {
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var transport = new CountingTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        for (var id = 1; id <= CacheCapacity + 20; id++) await operations.NbhoodsAsync(id);
        var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
        Assert.Equal(0, counts.Districts);
        Assert.Equal(CacheCapacity, counts.Neighbourhoods);
    }

    [Fact]
    public async Task ExpiredEntries_ArePrunedBeforeCapacityEviction()
    {
        using var context = CreateContext();
        var clock = new ManualTimeProvider(new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var transport = new CountingTransport();
        using var operations = new GisTkgmOperations(context, transport, clock);
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        for (var id = 1; id <= CacheCapacity; id++) await operations.DistrictsAsync(id);
        clock.Advance(TimeSpan.FromMinutes(16));
        await operations.DistrictsAsync(CacheCapacity + 1);
        Assert.Equal(1, GisTkgmOperations.GetAdministrativeCacheCountsForTesting().Districts);
    }

    private sealed class CountingTransport : ITkgmTransport
    {
        private int totalCalls;
        public int TotalCalls => Volatile.Read(ref totalCalls);
        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref totalCalls);
            return Task.FromResult(relativePath);
        }
    }

    private sealed class SteppingTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private long ticks = start.UtcTicks;
        public override DateTimeOffset GetUtcNow() => new(Interlocked.Add(ref ticks, TimeSpan.TicksPerMillisecond), TimeSpan.Zero);
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset current = now;
        public override DateTimeOffset GetUtcNow() => current;
        public void Advance(TimeSpan duration) => current = current.Add(duration);
    }
}
