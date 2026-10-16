using System;
using CityWorks.UserApi.Gis;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisProxyTargetPolicyTests
{
    [Fact]
    public void PublicTarget_ExtractsOneLabelServiceIdAndForwardsQuerySeparately()
    {
        var accepted = GisProxyTargetPolicy.TryParsePublicTarget(
            "?https://parks.gissrv.org/0/query?f=json&where=1%3D1",
            out var target,
            out var serviceId,
            out var query);

        Assert.True(accepted);
        Assert.Equal("parks", serviceId);
        Assert.Equal("/0/query", target.AbsolutePath);
        Assert.Equal("f=json&where=1%3D1", query);
    }

    [Theory]
    [InlineData("?http://parks.gissrv.org/0/query")]
    [InlineData("?https://parks.example.test/0/query")]
    [InlineData("?https://parks.gissrv.org.evil.test/0/query")]
    [InlineData("?https://evilgissrv.org/0/query")]
    [InlineData("?https://one.two.gissrv.org/0/query")]
    [InlineData("?https://user@parks.gissrv.org/0/query")]
    [InlineData("?https://.gissrv.org/0/query")]
    [InlineData("?https://one..gissrv.org/0/query")]
    [InlineData("?javascript:alert(1)")]
    [InlineData("?not-a-uri")]
    public void PublicTarget_RejectsNonCanonicalOrUntrustedVirtualHosts(string raw)
    {
        Assert.False(GisProxyTargetPolicy.TryParsePublicTarget(
            raw, out _, out _, out _));
    }

    [Theory]
    [InlineData("?https://parks.gissrv.org/0/%2e%2e/admin")]
    [InlineData("?https://parks.gissrv.org/0/%2E%2E/admin")]
    [InlineData("?https://parks.gissrv.org/0/%252e%252e/admin")]
    [InlineData("?https://parks.gissrv.org/0/%25252e%25252e/admin")]
    [InlineData("?https://parks.gissrv.org/0/%5c..%5cadmin")]
    [InlineData("?https://parks.gissrv.org/0/..%2fadmin")]
    public void PublicTarget_RejectsDirectAndRepeatedlyEncodedTraversal(string raw)
    {
        Assert.False(GisProxyTargetPolicy.TryParsePublicTarget(
            raw, out _, out _, out _));
    }

    [Fact]
    public void PublicTarget_AllowsTraversalLikeTextOnlyInsideForwardedQuery()
    {
        var accepted = GisProxyTargetPolicy.TryParsePublicTarget(
            "?https://parks.gissrv.org/0/query?where=label%3D'%252e%252e'",
            out _,
            out _,
            out var query);

        Assert.True(accepted);
        Assert.Contains("%252e%252e", query, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicTarget_ResetsOutputsWhenInputIsInvalid()
    {
        var accepted = GisProxyTargetPolicy.TryParsePublicTarget(
            "?https://not-trusted.example.test/0/query",
            out var target,
            out var serviceId,
            out var query);

        Assert.False(accepted);
        Assert.Null(target);
        Assert.Null(serviceId);
        Assert.Equal(string.Empty, query);
    }

    [Fact]
    public void UpstreamUri_AppendsValidatedPathToConfiguredServerInsteadOfPublicHost()
    {
        var target = new Uri("https://parks.gissrv.org/0/query");
        var upstream = GisProxyTargetPolicy.BuildUpstreamUri(
            "https://internal.example.test/arcgis/rest/services/Parks/MapServer",
            target,
            "f=json&where=1%3D1");

        Assert.NotNull(upstream);
        Assert.Equal("internal.example.test", upstream!.Host);
        Assert.Equal(
            "/arcgis/rest/services/Parks/MapServer/0/query",
            upstream.AbsolutePath);
        Assert.Equal("f=json&where=1%3D1", upstream.Query.TrimStart('?'));
    }

    [Fact]
    public void UpstreamUri_DoesNotDuplicateNumericFeatureLayerId()
    {
        var upstream = GisProxyTargetPolicy.BuildUpstreamUri(
            "https://internal.example.test/arcgis/rest/services/Parks/FeatureServer/0",
            new Uri("https://parks.gissrv.org/0/query"),
            "f=json");

        Assert.NotNull(upstream);
        Assert.Equal(
            "/arcgis/rest/services/Parks/FeatureServer/0/query",
            upstream!.AbsolutePath);
    }

    [Fact]
    public void UpstreamUri_PreservesConfiguredQueryBeforeForwardedQuery()
    {
        var upstream = GisProxyTargetPolicy.BuildUpstreamUri(
            "https://internal.example.test/arcgis/rest/services/Parks/MapServer?version=1",
            new Uri("https://parks.gissrv.org/0/query"),
            "f=json");

        Assert.NotNull(upstream);
        Assert.Equal("version=1&f=json", upstream!.Query.TrimStart('?'));
    }

    [Theory]
    [InlineData("relative/path")]
    [InlineData("javascript:alert(1)")]
    [InlineData("ftp://internal.example.test/arcgis")]
    [InlineData("https://user:password@internal.example.test/arcgis")]
    public void UpstreamUri_RejectsInvalidOrCredentialBearingConfiguredTarget(string configured)
    {
        Assert.Null(GisProxyTargetPolicy.BuildUpstreamUri(
            configured, new Uri("https://parks.gissrv.org/0/query"), "f=json"));
    }

    [Fact]
    public void UpstreamUri_RejectsNullPublicTarget()
    {
        Assert.Null(GisProxyTargetPolicy.BuildUpstreamUri(
            "https://internal.example.test/arcgis", null!, "f=json"));
    }

    [Fact]
    public void TokenAppend_EncodesValuesAndRetainsExistingQuery()
    {
        var result = GisProxyTargetPolicy.AppendQueryParameter(
            new Uri("https://internal.example.test/arcgis?f=json"),
            "token",
            "a+b /?&");

        Assert.Equal("f=json&token=a%2Bb%20%2F%3F%26", result.Query.TrimStart('?'));
    }

    [Fact]
    public void TokenAppend_RejectsMissingParameterIdentity()
    {
        Assert.Throws<ArgumentException>(() => GisProxyTargetPolicy.AppendQueryParameter(
            new Uri("https://internal.example.test/arcgis"), " ", "value"));
    }

    [Fact]
    public void TokenAppend_RejectsNullUriAndValue()
    {
        Assert.Throws<ArgumentNullException>(() => GisProxyTargetPolicy.AppendQueryParameter(
            null!, "token", "value"));
        Assert.Throws<ArgumentNullException>(() => GisProxyTargetPolicy.AppendQueryParameter(
            new Uri("https://internal.example.test/arcgis"), "token", null!));
    }
}
