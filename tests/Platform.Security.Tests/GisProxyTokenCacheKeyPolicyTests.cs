using System;
using System.Collections.Generic;
using CityWorks.UserApi.Gis;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisProxyTokenCacheKeyPolicyTests
{
    private const string Endpoint = "https://maps.example.test/arcgis/rest/services/Parks/MapServer";

    [Fact]
    public void IdenticalServiceAndCredentials_ReturnStableCacheKey()
    {
        var first = GisProxyTokenCacheKeyPolicy.Create(Endpoint, "reader", "secret");
        var second = GisProxyTokenCacheKeyPolicy.Create(Endpoint, "reader", "secret");

        Assert.Equal(first, second);
        Assert.StartsWith("gis-token:v2:", first, StringComparison.Ordinal);
        Assert.Equal("gis-token:v2:".Length + 64, first.Length);
    }

    [Fact]
    public void SharedServiceUrlWithDistinctAccounts_NeverSharesTokens()
    {
        var keys = new[]
        {
            GisProxyTokenCacheKeyPolicy.Create(Endpoint, "public", "secret"),
            GisProxyTokenCacheKeyPolicy.Create(Endpoint, "private", "secret"),
            GisProxyTokenCacheKeyPolicy.Create(Endpoint, "private", "rotated-secret"),
            GisProxyTokenCacheKeyPolicy.Create(Endpoint + "/0", "private", "secret"),
            GisProxyTokenCacheKeyPolicy.Create(Endpoint, "private", "secret"),
        };

        Assert.NotEqual(keys[0], keys[1]);
        Assert.NotEqual(keys[1], keys[2]);
        Assert.NotEqual(keys[1], keys[3]);
        Assert.Equal(keys[1], keys[4]);
        Assert.Equal(4, new HashSet<string>(keys).Count);
    }

    [Fact]
    public void DelimiterInjectionCannotCollideAcrossDistinctCredentialFields()
    {
        var first = GisProxyTokenCacheKeyPolicy.Create("https://maps.test/x:a", "b", "c");
        var second = GisProxyTokenCacheKeyPolicy.Create("https://maps.test/x", "a:b", "c");
        var third = GisProxyTokenCacheKeyPolicy.Create("https://maps.test/x", "a", "b:c");

        Assert.NotEqual(first, second);
        Assert.NotEqual(second, third);
        Assert.NotEqual(first, third);
    }

    [Theory]
    [InlineData(null, "reader", "secret")]
    [InlineData("", "reader", "secret")]
    [InlineData("https://maps.test", null, "secret")]
    [InlineData("https://maps.test", "", "secret")]
    [InlineData("https://maps.test", "reader", null)]
    [InlineData("https://maps.test", "reader", " ")]
    public void MissingCacheIdentity_FailsClosed(string? url, string? user, string? password)
    {
        Assert.Throws<ArgumentException>(() => GisProxyTokenCacheKeyPolicy.Create(url!, user!, password!));
    }

    [Fact]
    public void CacheKeyDoesNotContainRawEndpointCredentialsOrQuerySecrets()
    {
        var endpoint = Endpoint + "?token=private-value";
        var key = GisProxyTokenCacheKeyPolicy.Create(endpoint, "reader-private", "strong-password-private");

        Assert.DoesNotContain("private-value", key, StringComparison.Ordinal);
        Assert.DoesNotContain("reader-private", key, StringComparison.Ordinal);
        Assert.DoesNotContain("strong-password-private", key, StringComparison.Ordinal);
        Assert.DoesNotContain("maps.example.test", key, StringComparison.Ordinal);
        Assert.Matches("^gis-token:v2:[0-9A-F]{64}$", key);
    }

    [Fact]
    public void CredentialRotationInvalidatesPreviousTokenNamespace()
    {
        const string user = "gis-reader";
        var former = GisProxyTokenCacheKeyPolicy.Create(Endpoint, user, "old-password");
        var rotated = GisProxyTokenCacheKeyPolicy.Create(Endpoint, user, "new-password");
        var restored = GisProxyTokenCacheKeyPolicy.Create(Endpoint, user, "old-password");

        Assert.NotEqual(former, rotated);
        Assert.Equal(former, restored);
    }
}
