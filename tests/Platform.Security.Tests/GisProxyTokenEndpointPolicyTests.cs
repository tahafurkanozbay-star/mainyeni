using System;
using CityWorks.UserApi.Gis;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisProxyTokenEndpointPolicyTests
{
    [Fact]
    public void TokenEndpoint_PreservesNonDefaultHttpsPort()
    {
        var service = new Uri("https://maps.example.test:8443/arcgis/rest/services/Parks/MapServer");
        var endpoint = GisProxyTokenEndpointPolicy.Create(service);

        Assert.Equal("https", endpoint.Scheme);
        Assert.Equal("maps.example.test", endpoint.Host);
        Assert.Equal(8443, endpoint.Port);
        Assert.Equal("/arcgis/tokens/generateToken", endpoint.AbsolutePath);
    }

    [Fact]
    public void TokenEndpoint_UsesDefaultArcgisPathWhenNoWebGisSegmentExists()
    {
        var endpoint = GisProxyTokenEndpointPolicy.Create(
            new Uri("https://maps.example.test/arcgis/rest/services/Parks/MapServer"));

        Assert.Equal("https://maps.example.test/arcgis/tokens/generateToken", endpoint.AbsoluteUri);
    }

    [Theory]
    [InlineData("/webgis/rest/services/Parks/MapServer")]
    [InlineData("/WEBGIS/rest/services/Parks/MapServer")]
    [InlineData("/tenant/webgis/rest/services/Parks/MapServer")]
    public void TokenEndpoint_UsesWebGisRouteForCompleteCaseInsensitiveSegment(string path)
    {
        var endpoint = GisProxyTokenEndpointPolicy.Create(new Uri("https://maps.example.test" + path));
        Assert.Equal("/webgis/tokens/generateToken", endpoint.AbsolutePath);
    }

    [Fact]
    public void TokenEndpoint_DoesNotMistakeSimilarPathNameForWebGisSegment()
    {
        var endpoint = GisProxyTokenEndpointPolicy.Create(
            new Uri("https://maps.example.test/mywebgis/rest/services/Parks/MapServer"));
        Assert.Equal("/arcgis/tokens/generateToken", endpoint.AbsolutePath);
    }

    [Fact]
    public void TokenEndpoint_DropsResourcePathQueryAndFragment()
    {
        var endpoint = GisProxyTokenEndpointPolicy.Create(
            new Uri("https://maps.example.test:9443/webgis/rest/services/Layer?token=do-not-forward&f=json#fragment"));

        Assert.Equal("https://maps.example.test:9443/webgis/tokens/generateToken", endpoint.AbsoluteUri);
        Assert.Empty(endpoint.Query);
        Assert.Empty(endpoint.Fragment);
    }

    [Theory]
    [InlineData("http://maps.example.test/arcgis/rest/services/Parks/MapServer")]
    [InlineData("ftp://maps.example.test/arcgis/rest/services/Parks/MapServer")]
    public void TokenEndpoint_RejectsNonHttpsServiceUri(string value)
    {
        Assert.Throws<ArgumentException>(() => GisProxyTokenEndpointPolicy.Create(new Uri(value)));
    }

    [Fact]
    public void TokenEndpoint_RejectsCredentialBearingServiceUri()
    {
        Assert.Throws<ArgumentException>(() => GisProxyTokenEndpointPolicy.Create(
            new Uri("https://user:password@maps.example.test/arcgis/rest/services/Layer")));
    }

    [Fact]
    public void TokenEndpoint_RejectsRelativeUri()
    {
        Assert.Throws<ArgumentException>(() => GisProxyTokenEndpointPolicy.Create(
            new Uri("relative/path", UriKind.Relative)));
    }

    [Fact]
    public void TokenEndpoint_RejectsNullUri()
    {
        Assert.Throws<ArgumentNullException>(() => GisProxyTokenEndpointPolicy.Create(null!));
    }
}
