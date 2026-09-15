using Api.Core.Platform;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiPlatformDefaultsTests
{
    [Theory]
    [InlineData(null, "PGSQL")]
    [InlineData("", "PGSQL")]
    [InlineData("   ", "PGSQL")]
    [InlineData("pgsql", "PGSQL")]
    [InlineData(" PGSQL ", "PGSQL")]
    [InlineData("mysql", "MYSQL")]
    public void NormalizeProvider_ReturnsCanonicalValue(string? input, string expected)
    {
        Assert.Equal(expected, ApiPlatformDefaults.NormalizeProvider(input!));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("   ", null)]
    [InlineData("https://example.test/", "https://example.test")]
    [InlineData(" https://example.test/// ", "https://example.test")]
    [InlineData("http://localhost:3000/", "http://localhost:3000")]
    public void NormalizeOrigin_TrimsWhitespaceAndTrailingSlash(string? input, string? expected)
    {
        Assert.Equal(expected, ApiPlatformDefaults.NormalizeOrigin(input!));
    }

    [Theory]
    [InlineData(null, "/fallback", "/fallback")]
    [InlineData("", "/fallback", "/fallback")]
    [InlineData("health", "/fallback", "/health")]
    [InlineData("/health", "/fallback", "/health")]
    [InlineData(" /health/ready ", "/fallback", "/health/ready")]
    public void NormalizePath_ProducesLocalAbsolutePath(string? input, string fallback, string expected)
    {
        Assert.Equal(expected, ApiPlatformDefaults.NormalizePath(input!, fallback));
    }

    [Theory]
    [InlineData("abc")]
    [InlineData("ABC-123")]
    [InlineData("request_123")]
    [InlineData("trace.123")]
    [InlineData("trace:123")]
    [InlineData("1234567890abcdef")]
    public void IsValidCorrelationId_AcceptsSafeIdentifiers(string value)
    {
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(value, 96));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("with space")]
    [InlineData("with/slash")]
    [InlineData("with\\slash")]
    [InlineData("with?query")]
    [InlineData("with#fragment")]
    [InlineData("with\rreturn")]
    [InlineData("with\nnewline")]
    [InlineData("with\ttab")]
    [InlineData("ümlaut")]
    public void IsValidCorrelationId_RejectsUnsafeIdentifiers(string? value)
    {
        Assert.False(ApiPlatformDefaults.IsValidCorrelationId(value!, 96));
    }

    [Fact]
    public void IsValidCorrelationId_RejectsValueLongerThanConfiguredLimit()
    {
        Assert.False(ApiPlatformDefaults.IsValidCorrelationId(new string('a', 97), 96));
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(new string('a', 96), 96));
    }

    [Fact]
    public void IsValidCorrelationId_RejectsNonPositiveLimit()
    {
        Assert.False(ApiPlatformDefaults.IsValidCorrelationId("abc", 0));
        Assert.False(ApiPlatformDefaults.IsValidCorrelationId("abc", -1));
    }

    [Theory]
    [InlineData("https://example.test", true)]
    [InlineData("http://example.test", true)]
    [InlineData("http://localhost:3000", true)]
    [InlineData("https://127.0.0.1:5001", true)]
    [InlineData("ftp://example.test", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("example.test", false)]
    [InlineData("/relative", false)]
    [InlineData("https://example.test/path", false)]
    [InlineData("https://example.test/?q=1", false)]
    [InlineData("https://example.test/#fragment", false)]
    public void IsHttpOrigin_ValidatesSchemeAndOriginShape(string value, bool expected)
    {
        var result = ApiPlatformDefaults.IsHttpOrigin(value, out var uri);

        Assert.Equal(expected, result);
        if (expected)
        {
            Assert.NotNull(uri);
        }
        else
        {
            Assert.Null(uri);
        }
    }

    [Theory]
    [InlineData("http://localhost", true)]
    [InlineData("http://LOCALHOST:3000", true)]
    [InlineData("http://127.0.0.1", true)]
    [InlineData("http://[::1]", true)]
    [InlineData("https://example.test", false)]
    [InlineData("https://10.0.0.1", false)]
    public void IsLoopbackHost_RecognizesExplicitLoopbackHosts(string value, bool expected)
    {
        Assert.True(Uri.TryCreate(value, UriKind.Absolute, out var uri));
        Assert.Equal(expected, ApiPlatformDefaults.IsLoopbackHost(uri));
    }

    [Fact]
    public void IsLoopbackHost_ReturnsFalseForNull()
    {
        Assert.False(ApiPlatformDefaults.IsLoopbackHost(null!));
    }

    [Fact]
    public void PublicConstants_AreStableForCrossCuttingMiddleware()
    {
        Assert.Equal("SiteCorsPolicy", ApiPlatformDefaults.CorsPolicyName);
        Assert.Equal("X-Correlation-ID", ApiPlatformDefaults.CorrelationHeaderName);
        Assert.Equal("KentRehberi.TraceId", ApiPlatformDefaults.TraceIdItemKey);
        Assert.Equal("ready", ApiPlatformDefaults.ReadinessTag);
        Assert.Equal("live", ApiPlatformDefaults.LivenessTag);
        Assert.Equal("database", ApiPlatformDefaults.DatabaseHealthCheckName);
        Assert.Equal("PGSQL", ApiPlatformDefaults.PostgreSqlProvider);
        Assert.Equal("Primary", ApiPlatformDefaults.PrimaryConnectionStringName);
    }
}
