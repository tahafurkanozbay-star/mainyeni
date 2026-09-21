using Api.User.KentRehberi;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiBoundedCacheTests
{
    private static (
        KentRehberiBoundedResultCache Cache,
        KentRehberiTelemetry Telemetry,
        ManualKentRehberiTimeProvider Clock)
        CreateCache(
            Action<KentRehberiOptions>? configure = null)
    {
        var options =
            KentRehberiRuntimeTestData.Options(configure);
        var telemetry = new KentRehberiTelemetry();
        var clock = new ManualKentRehberiTimeProvider(
            new DateTimeOffset(
                2026,
                9,
                21,
                6,
                0,
                0,
                TimeSpan.Zero));

        return (
            new KentRehberiBoundedResultCache(
                options,
                telemetry,
                clock),
            telemetry,
            clock);
    }

    [Fact]
    public void MissingKey_IsCacheMiss()
    {
        var (cache, telemetry, _) = CreateCache();

        Assert.False(
            cache.TryGet("missing", out var value));
        Assert.Null(value);

        var snapshot = cache.GetSnapshot();
        Assert.Equal(1, snapshot.Misses);
        Assert.Equal(0, snapshot.Hits);

        telemetry.Dispose();
    }

    [Fact]
    public void SetThenGet_ReturnsSameCollection()
    {
        var (cache, telemetry, _) = CreateCache();
        var expected =
            KentRehberiRuntimeTestData.Collection();

        Assert.True(
            cache.Set(
                "key",
                expected,
                1024,
                TimeSpan.FromSeconds(10)));

        Assert.True(
            cache.TryGet(
                "key",
                out var actual));
        Assert.Same(expected, actual);

        var snapshot = cache.GetSnapshot();
        Assert.Equal(1, snapshot.Entries);
        Assert.Equal(1024, snapshot.Bytes);
        Assert.Equal(1, snapshot.Hits);
        Assert.Equal(1, snapshot.Writes);

        telemetry.Dispose();
    }

    [Fact]
    public void DisabledCache_RejectsWrites()
    {
        var (cache, telemetry, _) = CreateCache(
            options =>
                options.ResultCacheEnabled = false);

        Assert.False(
            cache.Set(
                "key",
                KentRehberiRuntimeTestData.Collection(),
                100,
                TimeSpan.FromSeconds(10)));

        Assert.Equal(
            0,
            cache.GetSnapshot().Entries);

        telemetry.Dispose();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void NonPositiveSize_IsNotCached(
        long bytes)
    {
        var (cache, telemetry, _) = CreateCache();

        Assert.False(
            cache.Set(
                "key",
                KentRehberiRuntimeTestData.Collection(),
                bytes,
                TimeSpan.FromSeconds(10)));

        Assert.Equal(
            0,
            cache.GetSnapshot().Writes);

        telemetry.Dispose();
    }

    [Fact]
    public void NonPositiveTtl_IsNotCached()
    {
        var (cache, telemetry, _) = CreateCache();

        Assert.False(
            cache.Set(
                "key",
                KentRehberiRuntimeTestData.Collection(),
                100,
                TimeSpan.Zero));

        telemetry.Dispose();
    }

    [Fact]
    public void OversizeItem_IsRejected()
    {
        var (cache, telemetry, _) = CreateCache(
            options =>
                options.ResultCacheMaxBytes = 1024 * 1024);

        Assert.False(
            cache.Set(
                "key",
                KentRehberiRuntimeTestData.Collection(),
                1024 * 1024 + 1,
                TimeSpan.FromSeconds(10)));

        var snapshot = cache.GetSnapshot();
        Assert.Equal(1, snapshot.OversizeRejected);
        Assert.Equal(0, snapshot.Entries);

        telemetry.Dispose();
    }

    [Fact]
    public void ExpiredItem_IsRemovedOnRead()
    {
        var (cache, telemetry, clock) = CreateCache();

        cache.Set(
            "key",
            KentRehberiRuntimeTestData.Collection(),
            100,
            TimeSpan.FromSeconds(5));

        clock.Advance(
            TimeSpan.FromSeconds(6));

        Assert.False(
            cache.TryGet("key", out _));

        var snapshot = cache.GetSnapshot();
        Assert.Equal(0, snapshot.Entries);
        Assert.Equal(1, snapshot.Expired);
        Assert.Equal(
            1,
            telemetry.GetSnapshot().CacheEvictions);

        telemetry.Dispose();
    }

    [Fact]
    public void EntryAtExactExpiry_IsExpired()
    {
        var (cache, telemetry, clock) = CreateCache();

        cache.Set(
            "key",
            KentRehberiRuntimeTestData.Collection(),
            100,
            TimeSpan.FromSeconds(5));

        clock.Advance(
            TimeSpan.FromSeconds(5));

        Assert.False(
            cache.TryGet("key", out _));

        telemetry.Dispose();
    }

    [Fact]
    public void Replacement_ReleasesPreviousByteBudget()
    {
        var (cache, telemetry, _) = CreateCache();

        cache.Set(
            "key",
            KentRehberiRuntimeTestData.Collection(),
            500,
            TimeSpan.FromSeconds(10));
        cache.Set(
            "key",
            KentRehberiRuntimeTestData.Collection(
                startId: 10),
            300,
            TimeSpan.FromSeconds(10));

        var snapshot = cache.GetSnapshot();
        Assert.Equal(1, snapshot.Entries);
        Assert.Equal(300, snapshot.Bytes);
        Assert.Equal(1, snapshot.Replacements);
        Assert.Equal(2, snapshot.Writes);

        telemetry.Dispose();
    }

    [Fact]
    public void EntryCapacity_EvictsLeastRecentlyUsed()
    {
        var (cache, telemetry, _) = CreateCache(
            options =>
                options.ResultCacheMaxEntries = 2);

        cache.Set(
            "a",
            KentRehberiRuntimeTestData.Collection(
                startId: 1),
            100,
            TimeSpan.FromMinutes(1));
        cache.Set(
            "b",
            KentRehberiRuntimeTestData.Collection(
                startId: 2),
            100,
            TimeSpan.FromMinutes(1));

        Assert.True(
            cache.TryGet("a", out _));

        cache.Set(
            "c",
            KentRehberiRuntimeTestData.Collection(
                startId: 3),
            100,
            TimeSpan.FromMinutes(1));

        Assert.True(
            cache.TryGet("a", out _));
        Assert.False(
            cache.TryGet("b", out _));
        Assert.True(
            cache.TryGet("c", out _));

        var snapshot = cache.GetSnapshot();
        Assert.Equal(2, snapshot.Entries);
        Assert.Equal(1, snapshot.CapacityEvictions);

        telemetry.Dispose();
    }

    [Fact]
    public void ByteCapacity_EvictsUntilWithinBudget()
    {
        var (cache, telemetry, _) = CreateCache(
            options =>
            {
                options.ResultCacheMaxEntries = 10;
                options.ResultCacheMaxBytes =
                    1024 * 1024;
            });

        cache.Set(
            "a",
            KentRehberiRuntimeTestData.Collection(),
            700_000,
            TimeSpan.FromMinutes(1));
        cache.Set(
            "b",
            KentRehberiRuntimeTestData.Collection(
                startId: 2),
            700_000,
            TimeSpan.FromMinutes(1));

        var snapshot = cache.GetSnapshot();
        Assert.Equal(1, snapshot.Entries);
        Assert.True(
            snapshot.Bytes <=
            snapshot.MaxBytes);
        Assert.Equal(
            1,
            snapshot.CapacityEvictions);

        telemetry.Dispose();
    }

    [Fact]
    public void Get_PromotesEntryForLru()
    {
        var (cache, telemetry, _) = CreateCache(
            options =>
                options.ResultCacheMaxEntries = 2);

        cache.Set(
            "first",
            KentRehberiRuntimeTestData.Collection(
                startId: 1),
            100,
            TimeSpan.FromMinutes(1));
        cache.Set(
            "second",
            KentRehberiRuntimeTestData.Collection(
                startId: 2),
            100,
            TimeSpan.FromMinutes(1));

        cache.TryGet("first", out _);

        cache.Set(
            "third",
            KentRehberiRuntimeTestData.Collection(
                startId: 3),
            100,
            TimeSpan.FromMinutes(1));

        Assert.True(
            cache.TryGet("first", out _));
        Assert.False(
            cache.TryGet("second", out _));

        telemetry.Dispose();
    }

    [Fact]
    public void SweepExpired_RemovesBoundedCount()
    {
        var (cache, telemetry, clock) = CreateCache(
            options =>
                options.ResultCacheMaxEntries = 10);

        for (var index = 0; index < 5; index++)
        {
            cache.Set(
                "k" + index,
                KentRehberiRuntimeTestData.Collection(
                    startId: index + 1),
                100,
                TimeSpan.FromSeconds(1));
        }

        clock.Advance(
            TimeSpan.FromSeconds(2));

        Assert.Equal(
            2,
            cache.SweepExpired(2));
        Assert.Equal(
            3,
            cache.GetSnapshot().Entries);

        Assert.Equal(
            3,
            cache.SweepExpired(10));
        Assert.Equal(
            0,
            cache.GetSnapshot().Entries);

        telemetry.Dispose();
    }

    [Fact]
    public void SweepExpired_DoesNotRemoveFreshEntries()
    {
        var (cache, telemetry, clock) = CreateCache();

        cache.Set(
            "expired",
            KentRehberiRuntimeTestData.Collection(),
            100,
            TimeSpan.FromSeconds(1));
        cache.Set(
            "fresh",
            KentRehberiRuntimeTestData.Collection(
                startId: 2),
            100,
            TimeSpan.FromMinutes(1));

        clock.Advance(
            TimeSpan.FromSeconds(2));

        Assert.Equal(
            1,
            cache.SweepExpired());

        Assert.False(
            cache.TryGet("expired", out _));
        Assert.True(
            cache.TryGet("fresh", out _));

        telemetry.Dispose();
    }

    [Fact]
    public void SweepExpired_RejectsInvalidLimit()
    {
        var (cache, telemetry, _) = CreateCache();

        Assert.Throws<ArgumentOutOfRangeException>(
            () =>
                cache.SweepExpired(0));

        telemetry.Dispose();
    }

    [Fact]
    public void Clear_ResetsLiveStorageButPreservesCounters()
    {
        var (cache, telemetry, _) = CreateCache();

        cache.Set(
            "a",
            KentRehberiRuntimeTestData.Collection(),
            100,
            TimeSpan.FromMinutes(1));
        cache.TryGet("a", out _);

        cache.Clear();

        var snapshot = cache.GetSnapshot();
        Assert.Equal(0, snapshot.Entries);
        Assert.Equal(0, snapshot.Bytes);
        Assert.Equal(1, snapshot.Writes);
        Assert.Equal(1, snapshot.Hits);

        telemetry.Dispose();
    }

    [Fact]
    public void BlankKeys_AreRejected()
    {
        var (cache, telemetry, _) = CreateCache();

        Assert.Throws<ArgumentException>(
            () =>
                cache.TryGet(" ", out _));

        Assert.Throws<ArgumentException>(
            () =>
                cache.Set(
                    "",
                    KentRehberiRuntimeTestData.Collection(),
                    100,
                    TimeSpan.FromSeconds(10)));

        telemetry.Dispose();
    }
}
