using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Api.User.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisProxyRequestBodyLimitMiddlewareTests
{
    [Fact]
    public async Task OversizedDeclaredBody_IsRejectedBeforeNextMiddleware()
    {
        var nextCalled = false;
        var middleware = new GisProxyRequestBodyLimitMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var context = CreateContext(HttpMethods.Post, "/Gis/Proxy");
        context.Request.ContentLength = GisProxyRequestBodyLimitMiddleware.MaxRequestBodyBytes + 1;

        await middleware.InvokeAsync(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        using var reader = new StreamReader(context.Response.Body, Encoding.UTF8, leaveOpen: true);
        Assert.Contains("too large", await reader.ReadToEndAsync(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ExactBudget_IsAdmittedAndAppliedToWritableServerFeature()
    {
        var nextCalled = false;
        var feature = new MutableMaxRequestBodySizeFeature();
        var middleware = new GisProxyRequestBodyLimitMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var context = CreateContext(HttpMethods.Post, "/Gis/Proxy");
        context.Request.ContentLength = GisProxyRequestBodyLimitMiddleware.MaxRequestBodyBytes;
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);

        await middleware.InvokeAsync(context);

        Assert.True(nextCalled);
        Assert.Equal(GisProxyRequestBodyLimitMiddleware.MaxRequestBodyBytes, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task ChunkedProxyRequest_GetsServerReadLimitBeforeNextMiddleware()
    {
        long? observedLimit = null;
        var feature = new MutableMaxRequestBodySizeFeature();
        var middleware = new GisProxyRequestBodyLimitMiddleware(context =>
        {
            observedLimit = context.Features.Get<IHttpMaxRequestBodySizeFeature>()?.MaxRequestBodySize;
            return Task.CompletedTask;
        });
        var context = CreateContext(HttpMethods.Post, "/Gis/Proxy");
        context.Request.ContentLength = null;
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);

        await middleware.InvokeAsync(context);

        Assert.Equal(GisProxyRequestBodyLimitMiddleware.MaxRequestBodyBytes, observedLimit);
    }

    [Theory]
    [InlineData("/gis/proxy")]
    [InlineData("/GIS/PROXY")]
    [InlineData("/Gis/Proxy")]
    public void ProxyPathMatching_IsCaseInsensitive(string path)
    {
        var context = CreateContext(HttpMethods.Post, path);
        Assert.True(GisProxyRequestBodyLimitMiddleware.IsProxyRequest(context.Request));
    }

    [Theory]
    [InlineData("/Gis/Proxy/extra")]
    [InlineData("/Gis/Proxy2")]
    [InlineData("/Other")]
    public void SimilarButDifferentPaths_AreNotCaptured(string path)
    {
        var context = CreateContext(HttpMethods.Post, path);
        Assert.False(GisProxyRequestBodyLimitMiddleware.IsProxyRequest(context.Request));
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public void UnsupportedMethods_AreNotCaptured(string method)
    {
        var context = CreateContext(method, "/Gis/Proxy");
        Assert.False(GisProxyRequestBodyLimitMiddleware.IsProxyRequest(context.Request));
    }

    [Fact]
    public async Task NonProxyRequest_PreservesExistingServerBodyLimit()
    {
        var feature = new MutableMaxRequestBodySizeFeature { MaxRequestBodySize = 12345 };
        var middleware = new GisProxyRequestBodyLimitMiddleware(_ => Task.CompletedTask);
        var context = CreateContext(HttpMethods.Post, "/Other");
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);

        await middleware.InvokeAsync(context);

        Assert.Equal(12345, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task ReadOnlyServerFeature_IsNotMutated()
    {
        var nextCalled = false;
        var feature = new ReadOnlyMaxRequestBodySizeFeature(98765);
        var middleware = new GisProxyRequestBodyLimitMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });
        var context = CreateContext(HttpMethods.Post, "/Gis/Proxy");
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);

        await middleware.InvokeAsync(context);

        Assert.True(nextCalled);
        Assert.Equal(98765, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task GetProxyRequest_StillReceivesFeatureBudget()
    {
        var feature = new MutableMaxRequestBodySizeFeature();
        var middleware = new GisProxyRequestBodyLimitMiddleware(_ => Task.CompletedTask);
        var context = CreateContext(HttpMethods.Get, "/Gis/Proxy");
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);

        await middleware.InvokeAsync(context);

        Assert.Equal(GisProxyRequestBodyLimitMiddleware.MaxRequestBodyBytes, feature.MaxRequestBodySize);
    }

    private static DefaultHttpContext CreateContext(string method, string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private sealed class MutableMaxRequestBodySizeFeature : IHttpMaxRequestBodySizeFeature
    {
        public bool IsReadOnly => false;
        public long? MaxRequestBodySize { get; set; }
    }

    private sealed class ReadOnlyMaxRequestBodySizeFeature : IHttpMaxRequestBodySizeFeature
    {
        public ReadOnlyMaxRequestBodySizeFeature(long? maxRequestBodySize)
        {
            MaxRequestBodySize = maxRequestBodySize;
        }

        public bool IsReadOnly => true;
        public long? MaxRequestBodySize { get; set; }
    }
}
