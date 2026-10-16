using System;
using System.Text.Json;
using CityWorks.UserApi.Gis;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisProxyTokenResponsePolicyTests
{
    private static readonly DateTimeOffset Now =
        new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);

    private static bool TryRead(
        string json,
        out string token,
        out TimeSpan cacheLifetime) =>
        GisProxyTokenResponsePolicy.TryReadToken(
            json,
            Now,
            TimeSpan.FromMinutes(30),
            TimeSpan.FromMinutes(2),
            out token,
            out cacheLifetime);

    private static string TokenResponse(string token, long? expiresMilliseconds = null) =>
        expiresMilliseconds.HasValue
            ? $"{{\"token\":{JsonSerializer.Serialize(token)},\"expires\":{expiresMilliseconds.Value}}}"
            : $"{{\"token\":{JsonSerializer.Serialize(token)}}}";

    [Fact]
    public void TokenLifetime_IsCappedByRequestedLifetimeAndSafetyMargin()
    {
        Assert.True(TryRead(
            TokenResponse("fresh-token", Now.AddHours(1).ToUnixTimeMilliseconds()),
            out var token,
            out var lifetime));

        Assert.Equal("fresh-token", token);
        Assert.Equal(TimeSpan.FromMinutes(28), lifetime);
    }

    [Fact]
    public void TokenLifetime_UsesShorterServerExpiryWithSafetyMargin()
    {
        Assert.True(TryRead(
            TokenResponse("fresh-token", Now.AddMinutes(10).ToUnixTimeMilliseconds()),
            out var token,
            out var lifetime));

        Assert.Equal("fresh-token", token);
        Assert.Equal(TimeSpan.FromMinutes(8), lifetime);
    }

    [Fact]
    public void TokenLifetime_AcceptsNumericExpirationEncodedAsString()
    {
        var json = $"{{\"token\":\"fresh-token\",\"expires\":\"{Now.AddMinutes(9).ToUnixTimeMilliseconds()}\"}}";
        Assert.True(TryRead(json, out _, out var lifetime));
        Assert.Equal(TimeSpan.FromMinutes(7), lifetime);
    }

    [Fact]
    public void MissingExpiration_UsesRequestedLifetimeMinusSafetyMargin()
    {
        Assert.True(TryRead(TokenResponse("fresh-token"), out _, out var lifetime));
        Assert.Equal(TimeSpan.FromMinutes(28), lifetime);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void ExpiredToken_IsRejected(long milliseconds)
    {
        AssertRejected(TokenResponse("expired-token", milliseconds));
    }

    [Fact]
    public void TokenAtSafetyMarginBoundary_IsRejected()
    {
        AssertRejected(TokenResponse("nearly-expired", Now.AddMinutes(2).ToUnixTimeMilliseconds()));
    }

    [Fact]
    public void ExpirationShorterThanSafetyMargin_IsRejected()
    {
        AssertRejected(TokenResponse("nearly-expired", Now.AddMinutes(1).ToUnixTimeMilliseconds()));
    }

    [Theory]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{\"error\":{\"message\":\"denied\"}}")]
    [InlineData("{\"token\":null}")]
    [InlineData("{\"token\":42}")]
    [InlineData("{\"token\":\"valid\",\"expires\":null}")]
    [InlineData("{\"token\":\"valid\",\"expires\":\"soon\"}")]
    [InlineData("{\"token\":\"valid\",\"expires\":1.5}")]
    [InlineData("{\"token\":\"valid\",\"expires\":{}}")]
    public void MalformedOrErrorResponses_AreRejected(string json)
    {
        AssertRejected(json);
    }

    [Fact]
    public void TokenWithWhitespaceOrControlCharacters_IsRejected()
    {
        AssertRejected(TokenResponse("bad token"));
        AssertRejected(TokenResponse("bad\r\ntoken"));
        AssertRejected(TokenResponse("   "));
    }

    [Fact]
    public void OverlongTokenAndOversizedResponse_AreRejected()
    {
        AssertRejected(TokenResponse(new string('t', 8193)));
        AssertRejected(new string('x', (64 * 1024) + 1));
    }

    [Fact]
    public void InvalidLifetimeConfiguration_IsRejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            GisProxyTokenResponsePolicy.TryReadToken(
                TokenResponse("token"), Now, TimeSpan.Zero, TimeSpan.Zero, out _, out _));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            GisProxyTokenResponsePolicy.TryReadToken(
                TokenResponse("token"), Now, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(2), out _, out _));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            GisProxyTokenResponsePolicy.TryReadToken(
                TokenResponse("token"), Now, TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(-1), out _, out _));
    }

    private static void AssertRejected(string json)
    {
        Assert.False(TryRead(json, out var token, out var lifetime));
        Assert.Null(token);
        Assert.Equal(TimeSpan.Zero, lifetime);
    }
}
