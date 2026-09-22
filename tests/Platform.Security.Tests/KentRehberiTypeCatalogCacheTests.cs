using Api.User.KentRehberi;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiTypeCatalogCacheTests
{
    [Fact]
    public void EmptyCache_IsAMiss()
    {
        var fixture = CreateFixture();

        Assert.False(
            fixture.Cache.TryGet(out _));

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.False(snapshot.HasValue);
        Assert.Equal(0, snapshot.Hits);
        Assert.Equal(1, snapshot.Misses);
        Assert.Equal(0, snapshot.Writes);
    }

    [Fact]
    public void SetThenGet_ReturnsSameCatalog()
    {
        var fixture = CreateFixture();
        var catalog =
            KentRehberiRuntimeTestData.TypeCatalog();

        fixture.Cache.Set(catalog);

        Assert.True(
            fixture.Cache.TryGet(
                out var actual));
        Assert.Same(catalog, actual);

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.True(snapshot.HasValue);
        Assert.Equal(1, snapshot.Hits);
        Assert.Equal(0, snapshot.Misses);
        Assert.Equal(1, snapshot.Writes);
    }

    [Fact]
    public void EntryExpiresAtConfiguredTtl()
    {
        var fixture =
            CreateFixture(
                ttlSeconds: 10);
        var catalog =
            KentRehberiRuntimeTestData.TypeCatalog();

        fixture.Cache.Set(catalog);
        fixture.Clock.Advance(
            TimeSpan.FromSeconds(9));

        Assert.True(
            fixture.Cache.TryGet(out _));

        fixture.Clock.Advance(
            TimeSpan.FromSeconds(1));

        Assert.False(
            fixture.Cache.TryGet(out _));

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.False(snapshot.HasValue);
        Assert.Equal(1, snapshot.Hits);
        Assert.Equal(1, snapshot.Misses);
    }

    [Fact]
    public void SetReplacesPreviousCatalogAndRefreshesExpiry()
    {
        var fixture =
            CreateFixture(
                ttlSeconds: 10);
        var first =
            KentRehberiRuntimeTestData.TypeCatalog(
                firstType: 1);
        var second =
            KentRehberiRuntimeTestData.TypeCatalog(
                firstType: 20);

        fixture.Cache.Set(first);
        fixture.Clock.Advance(
            TimeSpan.FromSeconds(8));
        fixture.Cache.Set(second);
        fixture.Clock.Advance(
            TimeSpan.FromSeconds(5));

        Assert.True(
            fixture.Cache.TryGet(
                out var actual));
        Assert.Same(second, actual);

        fixture.Clock.Advance(
            TimeSpan.FromSeconds(5));

        Assert.False(
            fixture.Cache.TryGet(out _));
    }

    [Fact]
    public void Clear_RemovesValueWithoutRewritingCounters()
    {
        var fixture = CreateFixture();
        fixture.Cache.Set(
            KentRehberiRuntimeTestData.TypeCatalog());

        fixture.Cache.Clear();

        Assert.False(
            fixture.Cache.GetSnapshot().HasValue);
        Assert.False(
            fixture.Cache.TryGet(out _));

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.Equal(1, snapshot.Writes);
        Assert.Equal(1, snapshot.Misses);
    }

    [Fact]
    public void SnapshotReportsStableExpiry()
    {
        var fixture =
            CreateFixture(
                ttlSeconds: 60);
        fixture.Cache.Set(
            KentRehberiRuntimeTestData.TypeCatalog());

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.NotNull(snapshot.ExpiresAt);
        Assert.Equal(
            fixture.Clock.GetUtcNow()
                .AddSeconds(60),
            snapshot.ExpiresAt);
    }

    [Fact]
    public void SnapshotDoesNotExposeExpiredEntry()
    {
        var fixture =
            CreateFixture(
                ttlSeconds: 1);
        fixture.Cache.Set(
            KentRehberiRuntimeTestData.TypeCatalog());

        fixture.Clock.Advance(
            TimeSpan.FromSeconds(2));

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.False(snapshot.HasValue);
        Assert.Null(snapshot.ExpiresAt);
    }

    [Fact]
    public void MultipleHitsAreCountedWithoutMutatingValue()
    {
        var fixture = CreateFixture();
        var catalog =
            KentRehberiRuntimeTestData.TypeCatalog();

        fixture.Cache.Set(catalog);

        for (var index = 0; index < 5; index++)
        {
            Assert.True(
                fixture.Cache.TryGet(
                    out var actual));
            Assert.Same(catalog, actual);
        }

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.Equal(5, snapshot.Hits);
        Assert.Equal(0, snapshot.Misses);
        Assert.Equal(1, snapshot.Writes);
    }

    [Fact]
    public void ExpiredReadDropsStoredValue()
    {
        var fixture =
            CreateFixture(
                ttlSeconds: 1);
        fixture.Cache.Set(
            KentRehberiRuntimeTestData.TypeCatalog());
        fixture.Clock.Advance(
            TimeSpan.FromSeconds(2));

        Assert.False(
            fixture.Cache.TryGet(out _));
        Assert.False(
            fixture.Cache.TryGet(out _));

        var snapshot =
            fixture.Cache.GetSnapshot();

        Assert.Equal(2, snapshot.Misses);
        Assert.False(snapshot.HasValue);
    }

    private static CacheFixture CreateFixture(
        int ttlSeconds = 30)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.TypeCatalogCacheTtlSeconds =
                        ttlSeconds);

        var clock =
            new ManualKentRehberiTimeProvider(
                new DateTimeOffset(
                    2026,
                    9,
                    22,
                    0,
                    0,
                    0,
                    TimeSpan.Zero));

        return new CacheFixture(
            clock,
            new KentRehberiTypeCatalogCache(
                options,
                clock));
    }

    private sealed record CacheFixture(
        ManualKentRehberiTimeProvider Clock,
        KentRehberiTypeCatalogCache Cache);
}
