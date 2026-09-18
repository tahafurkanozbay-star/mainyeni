using Api.User.KentRehberi;
using System;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiQueryValidationTests
{
    private static KentRehberiOptions CreateOptions() => new()
    {
        Enabled = true,
        DefaultLimit = 500,
        MaxLimit = 2_000,
        MaxRadiusMeters = 50_000,
        CommandTimeoutSeconds = 8,
        ConnectionTimeoutSeconds = 5,
        MaxPoolSize = 40,
        CacheMaxAgeSeconds = 30,
        HealthCheckTimeoutSeconds = 3,
        ObjectIdCursorEnabled = true
    };

    [Fact]
    public void NormalizeSearch_UsesBoundedDefaults()
    {
        var result = KentRehberiQueryValidation.NormalizeSearch(
            ilce: null,
            mahalle: null,
            tur: null,
            query: null,
            bbox: null,
            afterObjectId: null,
            limit: null,
            CreateOptions());

        Assert.Null(result.Ilce);
        Assert.Null(result.Mahalle);
        Assert.Null(result.Tur);
        Assert.Null(result.Query);
        Assert.Null(result.Bounds);
        Assert.Null(result.AfterObjectId);
        Assert.Equal(500, result.Limit);
    }

    [Fact]
    public void NormalizeSearch_TrimsTextAndParsesBbox()
    {
        var result = KentRehberiQueryValidation.NormalizeSearch(
            ilce: "  Çankaya  ",
            mahalle: "  Kızılay  ",
            tur: 7,
            query: "  belediye  ",
            bbox: "32.80,39.85,32.95,40.00",
            afterObjectId: 10,
            limit: 250,
            CreateOptions());

        Assert.Equal("Çankaya", result.Ilce);
        Assert.Equal("Kızılay", result.Mahalle);
        Assert.Equal((short)7, result.Tur);
        Assert.Equal("belediye", result.Query);
        Assert.Equal(10, result.AfterObjectId);
        Assert.Equal(250, result.Limit);
        Assert.NotNull(result.Bounds);
        Assert.Equal(32.80, result.Bounds!.MinLongitude, 6);
        Assert.Equal(39.85, result.Bounds.MinLatitude, 6);
        Assert.Equal(32.95, result.Bounds.MaxLongitude, 6);
        Assert.Equal(40.00, result.Bounds.MaxLatitude, 6);
    }

    [Theory]
    [InlineData("32.8,39.9,32.7,40.0")]
    [InlineData("32.8,40.0,33.0,39.9")]
    [InlineData("181,39.9,182,40.0")]
    [InlineData("32.8,-91,33.0,40.0")]
    [InlineData("32.8,39.9,33.0")]
    [InlineData("a,39.9,33.0,40.0")]
    public void NormalizeSearch_RejectsInvalidBbox(string bbox)
    {
        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                null,
                null,
                null,
                null,
                bbox,
                null,
                null,
                CreateOptions()));

        Assert.Contains("bbox", error.Errors.Keys);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(2001)]
    public void NormalizeSearch_RejectsUnsafeLimit(int limit)
    {
        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                null,
                null,
                null,
                null,
                null,
                null,
                limit,
                CreateOptions()));

        Assert.Contains("limit", error.Errors.Keys);
    }

    [Fact]
    public void NormalizeSearch_RejectsCursorUntilUniquenessIsExplicitlyVerified()
    {
        var options = CreateOptions();
        options.ObjectIdCursorEnabled = false;

        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                null,
                null,
                null,
                null,
                null,
                10,
                null,
                options));

        Assert.Contains("afterObjectId", error.Errors.Keys);
        Assert.Contains(
            error.Errors["afterObjectId"],
            message => message.Contains("uniqueness", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-100)]
    public void NormalizeSearch_RejectsNonPositiveCursor(int afterObjectId)
    {
        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                null,
                null,
                null,
                null,
                null,
                afterObjectId,
                null,
                CreateOptions()));

        Assert.Contains("afterObjectId", error.Errors.Keys);
    }

    [Fact]
    public void NormalizeSearch_RejectsTooShortFreeTextQuery()
    {
        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                null,
                null,
                null,
                "a",
                null,
                null,
                null,
                CreateOptions()));

        Assert.Contains("q", error.Errors.Keys);
    }

    [Fact]
    public void NormalizeSearch_TreatsBlankFreeTextAsNoFilter()
    {
        var result = KentRehberiQueryValidation.NormalizeSearch(
            null,
            null,
            null,
            "   ",
            null,
            null,
            null,
            CreateOptions());

        Assert.Null(result.Query);
    }

    [Fact]
    public void NormalizeSearch_RejectsOversizedText()
    {
        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                new string('a', KentRehberiQueryValidation.MaxDistrictLength + 1),
                null,
                null,
                new string('b', KentRehberiQueryValidation.MaxQueryLength + 1),
                null,
                null,
                null,
                CreateOptions()));

        Assert.Contains("ilce", error.Errors.Keys);
        Assert.Contains("q", error.Errors.Keys);
    }

    [Fact]
    public void NormalizeSearch_RejectsControlCharacters()
    {
        var error = Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeSearch(
                "Çankaya\nInjected",
                null,
                null,
                null,
                null,
                null,
                null,
                CreateOptions()));

        Assert.Contains("ilce", error.Errors.Keys);
    }

    [Fact]
    public void EscapeLikePattern_TreatsWildcardCharactersAsLiteralInput()
    {
        var escaped = KentRehberiQueryValidation.EscapeLikePattern(
            @"100%_test\value");

        Assert.Equal(@"100\%\_test\\value", escaped);
    }

    [Fact]
    public void NormalizeNearby_UsesTwoKilometerDefaultRadius()
    {
        var result = KentRehberiQueryValidation.NormalizeNearby(
            longitude: 32.85,
            latitude: 39.92,
            radiusMeters: null,
            ilce: null,
            mahalle: null,
            tur: null,
            query: null,
            limit: null,
            CreateOptions());

        Assert.Equal(32.85, result.Longitude, 6);
        Assert.Equal(39.92, result.Latitude, 6);
        Assert.Equal(2_000d, result.RadiusMeters);
        Assert.Equal(500, result.Limit);
    }

    [Theory]
    [InlineData(-181, 39.9, 1000)]
    [InlineData(181, 39.9, 1000)]
    [InlineData(32.8, -91, 1000)]
    [InlineData(32.8, 91, 1000)]
    [InlineData(32.8, 39.9, 0)]
    [InlineData(32.8, 39.9, 50001)]
    public void NormalizeNearby_RejectsOutOfRangeCoordinatesOrRadius(
        double longitude,
        double latitude,
        double radius)
    {
        Assert.Throws<KentRehberiValidationException>(() =>
            KentRehberiQueryValidation.NormalizeNearby(
                longitude,
                latitude,
                radius,
                null,
                null,
                null,
                null,
                null,
                CreateOptions()));
    }

    [Fact]
    public void Options_DefaultsPassValidation()
    {
        Assert.Empty(new KentRehberiOptions().Validate());
    }

    [Fact]
    public void Options_ReportMultipleUnsafeBounds()
    {
        var options = CreateOptions();
        options.DefaultLimit = 0;
        options.MaxLimit = 0;
        options.MaxRadiusMeters = 0;
        options.CommandTimeoutSeconds = 0;
        options.ConnectionTimeoutSeconds = 0;
        options.MaxPoolSize = 0;
        options.CacheMaxAgeSeconds = -1;
        options.HealthCheckTimeoutSeconds = 0;

        var failures = options.Validate();

        Assert.True(failures.Count >= 8);
        Assert.Contains(failures, x => x.Contains("DefaultLimit", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("MaxLimit", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("MaxRadiusMeters", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("CommandTimeoutSeconds", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("ConnectionTimeoutSeconds", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("MaxPoolSize", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("CacheMaxAgeSeconds", StringComparison.Ordinal));
        Assert.Contains(failures, x => x.Contains("HealthCheckTimeoutSeconds", StringComparison.Ordinal));
    }

    [Fact]
    public void Options_RejectPublicCeilingsAboveRepositorySafetyCaps()
    {
        var options = CreateOptions();
        options.MaxLimit = 2_001;
        options.MaxRadiusMeters = 50_001;

        var failures = options.Validate();

        Assert.Contains(
            failures,
            value => value.Contains("MaxLimit", StringComparison.Ordinal));
        Assert.Contains(
            failures,
            value => value.Contains("MaxRadiusMeters", StringComparison.Ordinal));
    }

    [Fact]
    public void Options_RejectDefaultLimitAboveMaximum()
    {
        var options = CreateOptions();
        options.DefaultLimit = 1000;
        options.MaxLimit = 500;

        var failures = options.Validate();

        Assert.Contains(
            failures,
            x => x.Contains("cannot exceed MaxLimit", StringComparison.Ordinal));
    }
}
