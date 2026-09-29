using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Concurrent;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

[Collection(TkgmAdministrativeCacheCollection.Name)]
public sealed class TkgmCacheByteBudgetTests
{
    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-byte-budget-" + Guid.NewGuid())
            .Options;
        return new BusinessContext(options);
    }

    [Fact]
    public async Task EntryAtExactByteLimit_IsCached()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var response = new string('x', GisTkgmOperations.MaxAdministrativeCacheEntryBytes);
        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(40_000_000, 41_000_000);
        var path = DistrictPath(id);

        try
        {
            Assert.Equal(response, await operations.DistrictsAsync(id));
            Assert.Equal(response, await operations.DistrictsAsync(id));

            Assert.Equal(1, transport.CallsFor(path));
            Assert.Equal((1, 0), GisTkgmOperations.GetAdministrativeCacheCountsForTesting());
            Assert.Equal(
                ((long)GisTkgmOperations.MaxAdministrativeCacheEntryBytes, 0L),
                GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task EntryAboveByteLimit_IsReturnedButNotCached()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var response = new string('x', GisTkgmOperations.MaxAdministrativeCacheEntryBytes + 1);
        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(41_000_000, 42_000_000);
        var path = DistrictPath(id);

        try
        {
            Assert.Equal(response, await operations.DistrictsAsync(id));
            Assert.Equal(response, await operations.DistrictsAsync(id));

            Assert.Equal(2, transport.CallsFor(path));
            Assert.Equal((0, 0), GisTkgmOperations.GetAdministrativeCacheCountsForTesting());
            Assert.Equal((0L, 0L), GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task EntryAdmission_UsesUtf8BytesInsteadOfCharacterCount()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var characterCount = GisTkgmOperations.MaxAdministrativeCacheEntryBytes / 3 + 1;
        var response = new string('€', characterCount);
        Assert.True(response.Length < GisTkgmOperations.MaxAdministrativeCacheEntryBytes);
        Assert.True(Encoding.UTF8.GetByteCount(response) > GisTkgmOperations.MaxAdministrativeCacheEntryBytes);

        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport);
        var id = Random.Shared.Next(42_000_000, 43_000_000);
        var path = DistrictPath(id);

        try
        {
            Assert.Equal(response, await operations.DistrictsAsync(id));
            Assert.Equal(response, await operations.DistrictsAsync(id));

            Assert.Equal(2, transport.CallsFor(path));
            Assert.Equal((0L, 0L), GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task TotalByteBudget_EvictsOldestAdministrativeEntry()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2034, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var response = new string('x', GisTkgmOperations.MaxAdministrativeCacheEntryBytes);
        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport, clock);
        var entriesPerBudget = GisTkgmOperations.MaxAdministrativeCacheBytes /
                               GisTkgmOperations.MaxAdministrativeCacheEntryBytes;
        Assert.True(entriesPerBudget > 1);
        Assert.Equal(0, GisTkgmOperations.MaxAdministrativeCacheBytes % GisTkgmOperations.MaxAdministrativeCacheEntryBytes);

        var firstId = 43_000_000;
        try
        {
            for (var offset = 0; offset < entriesPerBudget; offset++)
            {
                await operations.DistrictsAsync(firstId + offset);
                clock.Advance(TimeSpan.FromMilliseconds(1));
            }

            Assert.Equal(
                ((long)GisTkgmOperations.MaxAdministrativeCacheBytes, 0L),
                GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());

            var overflowId = firstId + entriesPerBudget;
            await operations.DistrictsAsync(overflowId);

            Assert.Equal(entriesPerBudget, GisTkgmOperations.GetAdministrativeCacheCountsForTesting().Districts);
            Assert.Equal(
                (long)GisTkgmOperations.MaxAdministrativeCacheBytes,
                GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting().Districts);

            var retainedId = firstId + 1;
            await operations.DistrictsAsync(retainedId);
            Assert.Equal(1, transport.CallsFor(DistrictPath(retainedId)));

            await operations.DistrictsAsync(firstId);
            Assert.Equal(2, transport.CallsFor(DistrictPath(firstId)));
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task ExpiredEntries_ArePrunedBeforeByteBudgetAdmission()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var clock = new SteppingTimeProvider(new DateTimeOffset(2035, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var response = new string('x', GisTkgmOperations.MaxAdministrativeCacheEntryBytes);
        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport, clock);
        var entriesPerBudget = GisTkgmOperations.MaxAdministrativeCacheBytes /
                               GisTkgmOperations.MaxAdministrativeCacheEntryBytes;
        var firstId = 44_000_000;

        try
        {
            for (var offset = 0; offset < entriesPerBudget; offset++)
                await operations.DistrictsAsync(firstId + offset);

            clock.Advance(TimeSpan.FromMinutes(15));
            var replacementId = firstId + entriesPerBudget;
            await operations.DistrictsAsync(replacementId);

            Assert.Equal((1, 0), GisTkgmOperations.GetAdministrativeCacheCountsForTesting());
            Assert.Equal(
                ((long)GisTkgmOperations.MaxAdministrativeCacheEntryBytes, 0L),
                GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());

            await operations.DistrictsAsync(firstId);
            Assert.Equal(2, transport.CallsFor(DistrictPath(firstId)));
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task OversizedAdmission_DoesNotEvictExistingCacheEntries()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var smallId = 45_000_001;
        var oversizedId = 45_000_002;
        var smallResponse = "small-stable-response";
        var oversizedResponse = new string('x', GisTkgmOperations.MaxAdministrativeCacheEntryBytes + 1);
        var transport = new CountingTransport(path =>
            path == DistrictPath(oversizedId) ? oversizedResponse : smallResponse);
        using var operations = new GisTkgmOperations(context, transport);

        try
        {
            Assert.Equal(smallResponse, await operations.DistrictsAsync(smallId));
            Assert.Equal(oversizedResponse, await operations.DistrictsAsync(oversizedId));
            Assert.Equal(oversizedResponse, await operations.DistrictsAsync(oversizedId));
            Assert.Equal(smallResponse, await operations.DistrictsAsync(smallId));

            Assert.Equal(1, transport.CallsFor(DistrictPath(smallId)));
            Assert.Equal(2, transport.CallsFor(DistrictPath(oversizedId)));
            Assert.Equal((1, 0), GisTkgmOperations.GetAdministrativeCacheCountsForTesting());
            Assert.Equal(
                ((long)Encoding.UTF8.GetByteCount(smallResponse), 0L),
                GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task DistrictAndNeighbourhoodCaches_HaveIndependentByteBudgets()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var response = new string('x', GisTkgmOperations.MaxAdministrativeCacheEntryBytes);
        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport);
        var entriesPerBudget = GisTkgmOperations.MaxAdministrativeCacheBytes /
                               GisTkgmOperations.MaxAdministrativeCacheEntryBytes;
        var districtBase = 46_000_000;
        var neighbourhoodId = 47_000_000;

        try
        {
            for (var offset = 0; offset < entriesPerBudget; offset++)
                await operations.DistrictsAsync(districtBase + offset);

            await operations.NbhoodsAsync(neighbourhoodId);
            var counts = GisTkgmOperations.GetAdministrativeCacheCountsForTesting();
            var bytes = GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting();

            Assert.Equal(entriesPerBudget, counts.Districts);
            Assert.Equal(1, counts.Neighbourhoods);
            Assert.Equal((long)GisTkgmOperations.MaxAdministrativeCacheBytes, bytes.Districts);
            Assert.Equal((long)GisTkgmOperations.MaxAdministrativeCacheEntryBytes, bytes.Neighbourhoods);
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    [Fact]
    public async Task ParcelResponses_DoNotConsumeAdministrativeCacheBytes()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var response = new string('p', GisTkgmOperations.MaxAdministrativeCacheEntryBytes + 1);
        var transport = new CountingTransport(_ => response);
        using var operations = new GisTkgmOperations(context, transport);

        try
        {
            Assert.Equal(response, await operations.ParcelAsync(6, 42, 101, 7));
            Assert.Equal(response, await operations.ParcelAsync(6, 42, 101, 7));
            Assert.Equal((0, 0), GisTkgmOperations.GetAdministrativeCacheCountsForTesting());
            Assert.Equal((0L, 0L), GisTkgmOperations.GetAdministrativeCacheByteCountsForTesting());
            Assert.Equal(2, transport.CallsFor("/parsel/42/101/7"));
        }
        finally
        {
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }
    }

    private static string DistrictPath(int id) => "/idariYapi/ilceListe/" + id;

    private sealed class CountingTransport : ITkgmTransport
    {
        private readonly Func<string, string> responseFactory;
        private readonly ConcurrentDictionary<string, int> calls = new(StringComparer.Ordinal);

        public CountingTransport(Func<string, string> responseFactory)
        {
            this.responseFactory = responseFactory ?? throw new ArgumentNullException(nameof(responseFactory));
        }

        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            calls.AddOrUpdate(relativePath, 1, static (_, count) => checked(count + 1));
            return Task.FromResult(responseFactory(relativePath));
        }

        public int CallsFor(string relativePath) => calls.TryGetValue(relativePath, out var count) ? count : 0;
    }

    private sealed class SteppingTimeProvider : TimeProvider
    {
        private DateTimeOffset utcNow;

        public SteppingTimeProvider(DateTimeOffset utcNow) => this.utcNow = utcNow;
        public override DateTimeOffset GetUtcNow() => utcNow;
        public void Advance(TimeSpan duration) => utcNow += duration;
    }
}
