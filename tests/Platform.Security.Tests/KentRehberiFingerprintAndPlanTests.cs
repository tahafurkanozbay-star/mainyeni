using Api.User.KentRehberi;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiFingerprintAndPlanTests
{
    [Fact]
    public void SearchFingerprint_IsDeterministic()
    {
        var criteria = KentRehberiRuntimeTestData.Search();

        var first = KentRehberiQueryFingerprint.ForSearch(criteria);
        var second = KentRehberiQueryFingerprint.ForSearch(criteria);

        Assert.Equal(first, second);
        Assert.Equal(64, first.Length);
        Assert.Equal(first, first.ToLowerInvariant());
    }

    [Fact]
    public void SearchFingerprint_DoesNotExposeFreeText()
    {
        var criteria = KentRehberiRuntimeTestData.Search(
            query: "özel arama değeri");

        var fingerprint =
            KentRehberiQueryFingerprint.ForSearch(criteria);

        Assert.DoesNotContain(
            "özel",
            fingerprint,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "arama",
            fingerprint,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void SearchFingerprint_ChangesForDistrict()
    {
        var first = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(ilce: "Çankaya"));
        var second = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(ilce: "Keçiören"));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void SearchFingerprint_ChangesForNeighborhood()
    {
        var first = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(mahalle: "Kızılay"));
        var second = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(mahalle: "Bahçelievler"));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void SearchFingerprint_ChangesForType()
    {
        var first = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(tur: 1));
        var second = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(tur: 2));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void SearchFingerprint_ChangesForLimit()
    {
        var first = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(limit: 10));
        var second = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(limit: 11));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void SearchFingerprint_ChangesForCursor()
    {
        var first = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(afterObjectId: 10));
        var second = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(afterObjectId: 11));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void SearchFingerprint_ChangesForBounds()
    {
        var first = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(
                bounds: new KentRehberiBounds(
                    32.80,
                    39.80,
                    32.90,
                    39.90)));
        var second = KentRehberiQueryFingerprint.ForSearch(
            KentRehberiRuntimeTestData.Search(
                bounds: new KentRehberiBounds(
                    32.81,
                    39.80,
                    32.90,
                    39.90)));

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void NearbyFingerprint_IsDeterministic()
    {
        var criteria =
            KentRehberiRuntimeTestData.Nearby();

        var first =
            KentRehberiQueryFingerprint.ForNearby(criteria);
        var second =
            KentRehberiQueryFingerprint.ForNearby(criteria);

        Assert.Equal(first, second);
        Assert.Equal(64, first.Length);
    }

    [Theory]
    [InlineData(32.84, 39.92, 2000)]
    [InlineData(32.85, 39.91, 2000)]
    [InlineData(32.85, 39.92, 2100)]
    public void NearbyFingerprint_ChangesForSpatialInputs(
        double longitude,
        double latitude,
        double radius)
    {
        var baseline =
            KentRehberiQueryFingerprint.ForNearby(
                KentRehberiRuntimeTestData.Nearby());

        var changed =
            KentRehberiQueryFingerprint.ForNearby(
                KentRehberiRuntimeTestData.Nearby(
                    longitude,
                    latitude,
                    radius));

        Assert.NotEqual(baseline, changed);
    }

    [Fact]
    public void ObjectFingerprint_ChangesPerObject()
    {
        Assert.NotEqual(
            KentRehberiQueryFingerprint.ForObjectId(1),
            KentRehberiQueryFingerprint.ForObjectId(2));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void ObjectFingerprint_RejectsInvalidIds(
        int objectId)
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () =>
                KentRehberiQueryFingerprint.ForObjectId(
                    objectId));
    }

    [Fact]
    public void Hash_RejectsBlankCanonicalInput()
    {
        Assert.Throws<ArgumentException>(
            () =>
                KentRehberiQueryFingerprint.Hash(" "));
    }

    [Fact]
    public void SearchPlan_UsesConfiguredDeadline()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.QueryDeadlineMilliseconds = 4321);

        var plan = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(),
            options);

        Assert.Equal(
            TimeSpan.FromMilliseconds(4321),
            plan.Deadline);
    }

    [Fact]
    public void SearchPlan_RespectsCacheToggle()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.ResultCacheEnabled = false);

        var plan = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(),
            options);

        Assert.False(plan.Cacheable);
    }

    [Fact]
    public void SearchPlan_UnfilteredQueryUsesShorterTtl()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.ResultCacheTtlSeconds = 20);

        var filtered = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(),
            options);
        var unfiltered = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(
                ilce: null,
                mahalle: null,
                tur: null,
                query: null),
            options);

        Assert.True(
            unfiltered.CacheTtl <
            filtered.CacheTtl);
    }

    [Fact]
    public void NearbyPlan_UsesShorterCacheTtlThanSearch()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.ResultCacheTtlSeconds = 30);

        var search = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(),
            options);
        var nearby = KentRehberiQueryPlan.Nearby(
            KentRehberiRuntimeTestData.Nearby(),
            options);

        Assert.True(
            nearby.CacheTtl <
            search.CacheTtl);
    }

    [Fact]
    public void NearbyPlan_LargeRadiusCostsMore()
    {
        var options =
            KentRehberiRuntimeTestData.Options();

        var small = KentRehberiQueryPlan.Nearby(
            KentRehberiRuntimeTestData.Nearby(
                radiusMeters: 100),
            options);
        var large = KentRehberiQueryPlan.Nearby(
            KentRehberiRuntimeTestData.Nearby(
                radiusMeters: 49_000),
            options);

        Assert.True(
            large.EstimatedCost >
            small.EstimatedCost);
    }

    [Fact]
    public void SearchPlan_LargeLimitCostsMore()
    {
        var options =
            KentRehberiRuntimeTestData.Options();

        var small = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(
                limit: 10),
            options);
        var large = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(
                limit: 200),
            options);

        Assert.True(
            large.EstimatedCost >
            small.EstimatedCost);
    }

    [Fact]
    public void SearchPlan_SpatialBoundReducesUnboundedPenalty()
    {
        var options =
            KentRehberiRuntimeTestData.Options();

        var unbounded = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(
                ilce: null,
                mahalle: null,
                tur: null,
                query: null,
                bounds: null),
            options);
        var bounded = KentRehberiQueryPlan.Search(
            KentRehberiRuntimeTestData.Search(
                ilce: null,
                mahalle: null,
                tur: null,
                query: null,
                bounds: new KentRehberiBounds(
                    32.84,
                    39.90,
                    32.86,
                    39.94)),
            options);

        Assert.True(
            unbounded.EstimatedCost >
            bounded.EstimatedCost);
    }

    [Fact]
    public void ObjectPlan_IsNotCached()
    {
        var plan =
            KentRehberiQueryPlan.ObjectById(
                123,
                KentRehberiRuntimeTestData.Options());

        Assert.False(plan.Cacheable);
        Assert.Equal(TimeSpan.Zero, plan.CacheTtl);
        Assert.Equal(1, plan.EstimatedCost);
        Assert.Equal("object", plan.Operation);
    }
}
