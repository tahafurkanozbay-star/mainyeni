using Api.Core.Platform;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestGuardMiddlewareTests
{
    [Fact]
    public async Task Invoke_RejectsDeclaredBodyLargerThanGlobalLimit()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        context.Request.ContentLength = 1025;
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        Assert.Equal("application/problem+json", context.Response.ContentType);
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
        var body = await ReadBody(context);
        Assert.Contains("Request payload too large", body, StringComparison.Ordinal);
        Assert.DoesNotContain("1025", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_AllowsBodyExactlyAtGlobalLimit()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        context.Request.ContentLength = 1024;
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
        Assert.NotEqual(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
    }

    [Fact]
    public async Task Invoke_AllowsRequestWithoutDeclaredContentLength()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        context.Request.ContentLength = null;
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task Invoke_LowersServerBodyFeatureWhenExistingLimitIsHigher()
    {
        var options = CreateOptions(maxBytes: 2048);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 10_000,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(2048, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_SetsServerBodyFeatureWhenExistingLimitIsUnlimited()
    {
        var options = CreateOptions(maxBytes: 4096);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = null,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(4096, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_DoesNotRaiseStricterExistingServerLimit()
    {
        var options = CreateOptions(maxBytes: 4096);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 1024,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(1024, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_DoesNotMutateReadOnlyServerBodyFeature()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 10_000,
            IsReadOnlyValue = true
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(10_000, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_IncludesSafeCorrelationIdInProblemPayload()
    {
        var options = CreateOptions(maxBytes: 1000);
        var context = CreateContext();
        context.Request.ContentLength = 1001;
        context.Items[ApiPlatformDefaults.TraceIdItemKey] = "correlation-123";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var body = await ReadBody(context);
        Assert.Contains("correlation-123", body, StringComparison.Ordinal);
        Assert.Contains(context.TraceIdentifier, body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_PreservesDownstreamResponseForAllowedRequest()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        context.Request.ContentLength = 100;
        var middleware = CreateMiddleware(async httpContext =>
        {
            httpContext.Response.StatusCode = StatusCodes.Status201Created;
            await httpContext.Response.WriteAsync("created");
        }, options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status201Created, context.Response.StatusCode);
        Assert.Equal("created", await ReadBody(context));
    }

    [Fact]
    public async Task Invoke_ThrowsForNullContext()
    {
        var middleware = CreateMiddleware(_ => Task.CompletedTask, CreateOptions(1024));

        await Assert.ThrowsAsync<ArgumentNullException>(() => middleware.Invoke(null!));
    }

    private static RequestGuardMiddleware CreateMiddleware(RequestDelegate next, ApiPlatformOptions options)
    {
        return new RequestGuardMiddleware(
            next,
            Options.Create(options),
            NullLogger<RequestGuardMiddleware>.Instance);
    }

    private static ApiPlatformOptions CreateOptions(long maxBytes)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxRequestBodyBytes = maxBytes;
        return options;
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static async Task<string> ReadBody(HttpContext context)
    {
        context.Response.Body.Position = 0;
        using var reader = new StreamReader(
            context.Response.Body,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: false,
            leaveOpen: true);
        return await reader.ReadToEndAsync();
    }

    private sealed class MutableBodySizeFeature : IHttpMaxRequestBodySizeFeature
    {
        public bool IsReadOnly => IsReadOnlyValue;

        public bool IsReadOnlyValue { get; set; }

        public long? MaxRequestBodySize { get; set; }
    }
}
