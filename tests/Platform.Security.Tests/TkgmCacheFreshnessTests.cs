using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class TkgmCacheFreshnessTests
{
    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-freshness-" + Guid.NewGuid())
            .Options;
        return new BusinessContext(options);
    }

    [Fact]
    public async Task DistrictCache_ReusesResponseBeforeFifteenMinuteTtl()
    {
        using var context = CreateContext();
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 27, 0, 0, 0, TimeSpan.Zero));
        var transport = new SequenceTransport("district-v1", "district-v2");
        using var operations = new GisTkgmOperations(context, transport, clock);
        var id = Random.Shared.Next(10_000_000, 11_000_000);

        var first = await operations.DistrictsAsync(id);
        clock.Advance(TimeSpan.FromMinutes(14) + TimeSpan.FromSeconds(59));
        var second = await operations.DistrictsAsync(id);

        Assert.Equal("district-v1", first);
        Assert.Equal("district-v1", second);
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task DistrictCache_RefreshesAtFifteenMinuteBoundary()
    {
        using var context = CreateContext();
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 27, 0, 0, 0, TimeSpan.Zero));
        var transport = new SequenceTransport("district-v1", "district-v2");
        using var operations = new GisTkgmOperations(context, transport, clock);
        var id = Random.Shared.Next(11_000_001, 12_000_000);

        Assert.Equal("district-v1", await operations.DistrictsAsync(id));
        clock.Advance(TimeSpan.FromMinutes(15));
        Assert.Equal("district-v2", await operations.DistrictsAsync(id));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task NeighbourhoodCache_RefreshesAfterTtl()
    {
        using var context = CreateContext();
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 9, 27, 0, 0, 0, TimeSpan.Zero));
        var transport = new SequenceTransport("neighbourhood-v1", "neighbourhood-v2");
        using var operations = new GisTkgmOperations(context, transport, clock);
        var id = Random.Shared.Next(12_000_001, 13_000_000);

        Assert.Equal("neighbourhood-v1", await operations.NbhoodsAsync(id));
        clock.Advance(TimeSpan.FromMinutes(16));
        Assert.Equal("neighbourhood-v2", await operations.NbhoodsAsync(id));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task ClockRollback_InvalidatesEntryInsteadOfServingFutureDatedCache()
    {
        using var context = CreateContext();
        var start = new DateTimeOffset(2026, 9, 27, 0, 0, 0, TimeSpan.Zero);
        var clock = new ManualTimeProvider(start);
        var transport = new SequenceTransport("district-v1", "district-v2");
        using var operations = new GisTkgmOperations(context, transport, clock);
        var id = Random.Shared.Next(13_000_001, 14_000_000);

        Assert.Equal("district-v1", await operations.DistrictsAsync(id));
        clock.SetUtcNow(start - TimeSpan.FromMinutes(1));
        Assert.Equal("district-v2", await operations.DistrictsAsync(id));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public async Task EmptyAdministrativeResponse_IsRejectedAndNotCached()
    {
        using var context = CreateContext();
        var clock = new ManualTimeProvider(DateTimeOffset.UtcNow);
        var transport = new SequenceTransport(" ", "recovered");
        using var operations = new GisTkgmOperations(context, transport, clock);
        var id = Random.Shared.Next(14_000_001, 15_000_000);

        await Assert.ThrowsAsync<InvalidOperationException>(() => operations.DistrictsAsync(id));
        Assert.Equal("recovered", await operations.DistrictsAsync(id));
        Assert.Equal(2, transport.CallCount);
    }

    [Fact]
    public void Constructor_RejectsNullTimeProvider()
    {
        using var context = CreateContext();
        var transport = new SequenceTransport("unused");

        Assert.Throws<ArgumentNullException>(() => new GisTkgmOperations(context, transport, null!));
    }

    private sealed class SequenceTransport : ITkgmTransport
    {
        private readonly Queue<string> responses;
        public int CallCount { get; private set; }

        public SequenceTransport(params string[] responses) => this.responses = new Queue<string>(responses);

        public Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CallCount++;
            if (responses.Count == 0) throw new InvalidOperationException("No test response remains.");
            return Task.FromResult(responses.Dequeue());
        }
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset utcNow;

        public ManualTimeProvider(DateTimeOffset utcNow) => this.utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan duration) => utcNow += duration;

        public void SetUtcNow(DateTimeOffset value) => utcNow = value;
    }
}