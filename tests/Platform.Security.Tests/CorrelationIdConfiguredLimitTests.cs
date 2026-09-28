using Api.Core.Platform;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class CorrelationIdConfiguredLimitTests
{
    [Theory]
    [InlineData(16)]
    [InlineData(20)]
    [InlineData(31)]
    public async Task Invoke_ServerFallbackNeverExceedsConfiguredMaximum(int maxLength)
    {
        var options = CreateOptions(maxLength);
        var context = CreateContext();
        context.TraceIdentifier = "unsafe trace identifier with spaces";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var correlationId = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(maxLength, correlationId.Length);
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(correlationId, maxLength));
        Assert.All(correlationId, character => Assert.True(Uri.IsHexDigit(character)));
        Assert.Equal(
            correlationId,
            context.Response.Headers[options.Requests.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task Invoke_DefaultLimitPreservesFullGuidFallback()
    {
        var options = CreateOptions(96);
        var context = CreateContext();
        context.TraceIdentifier = "unsafe trace";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var correlationId = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(32, correlationId.Length);
        Assert.True(Guid.TryParseExact(correlationId, "N", out _));
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(correlationId, 96));
    }

    [Fact]
    public async Task Invoke_UsesServerTraceExactlyAtConfiguredBoundary()
    {
        var options = CreateOptions(16);
        var context = CreateContext();
        context.TraceIdentifier = "trace-1234567890";
        Assert.Equal(16, context.TraceIdentifier.Length);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(
            context.TraceIdentifier,
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(
            context.TraceIdentifier,
            context.Response.Headers[options.Requests.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task Invoke_DoesNotUseOtherwiseSafeServerTraceAboveConfiguredLimit()
    {
        var options = CreateOptions(16);
        var context = CreateContext();
        context.TraceIdentifier = "server-trace-identifier-that-is-safe";
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(context.TraceIdentifier, 96));
        Assert.False(ApiPlatformDefaults.IsValidCorrelationId(context.TraceIdentifier, 16));
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var correlationId = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.NotEqual(context.TraceIdentifier, correlationId);
        Assert.Equal(16, correlationId.Length);
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(correlationId, 16));
    }

    [Fact]
    public async Task Invoke_InvalidInboundReplacementAlsoHonorsConfiguredMaximum()
    {
        var options = CreateOptions(20);
        options.Requests.RejectTraceHeaderWithInvalidCharacters = false;
        var context = CreateContext();
        context.TraceIdentifier = "server-trace-that-exceeds-twenty-characters";
        context.Request.Headers[options.Requests.CorrelationHeaderName] =
            "invalid inbound correlation id";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        var correlationId = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(20, correlationId.Length);
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(correlationId, 20));
        Assert.NotEqual(context.TraceIdentifier, correlationId);
    }

    [Fact]
    public async Task Invoke_ValidInboundBoundaryStillTakesPrecedenceOverServerTrace()
    {
        var options = CreateOptions(16);
        var context = CreateContext();
        context.TraceIdentifier = "safe-server-trace";
        const string inbound = "client-123456789";
        Assert.Equal(16, inbound.Length);
        context.Request.Headers[options.Requests.CorrelationHeaderName] = inbound;
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(inbound, context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(
            inbound,
            context.Response.Headers[options.Requests.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task Invoke_ReappliesBoundedServerOwnedHeaderOnResponseStart()
    {
        var options = CreateOptions(16);
        var context = CreateContext();
        context.TraceIdentifier = "unsafe trace identifier";
        var middleware = CreateMiddleware(
            httpContext =>
            {
                httpContext.Response.Headers[options.Requests.CorrelationHeaderName] =
                    "downstream-overwrite";
                return Task.CompletedTask;
            },
            options);

        await middleware.Invoke(context);
        var expected = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal("downstream-overwrite", context.Response.Headers[
            options.Requests.CorrelationHeaderName].ToString());

        await context.Response.StartAsync();

        Assert.Equal(
            expected,
            context.Response.Headers[options.Requests.CorrelationHeaderName].ToString());
        Assert.Equal(16, expected.Length);
    }

    [Fact]
    public async Task Invoke_CustomHeaderNameUsesSameConfiguredBound()
    {
        var options = CreateOptions(20);
        options.Requests.CorrelationHeaderName = "X-Request-ID";
        var context = CreateContext();
        context.TraceIdentifier = new string('a', 21);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var correlationId = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(20, correlationId.Length);
        Assert.Equal(
            correlationId,
            context.Response.Headers["X-Request-ID"].ToString());
        Assert.False(context.Response.Headers.ContainsKey(
            ApiPlatformDefaults.CorrelationHeaderName));
    }

    [Theory]
    [InlineData(16)]
    [InlineData(32)]
    [InlineData(96)]
    [InlineData(256)]
    public async Task Invoke_EveryServerGeneratedValueSatisfiesSharedValidator(int maxLength)
    {
        var options = CreateOptions(maxLength);
        var context = CreateContext();
        context.TraceIdentifier = "not valid because it contains spaces";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var correlationId = Assert.IsType<string>(
            context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(correlationId, maxLength));
        Assert.InRange(correlationId.Length, 1, maxLength);
    }

    private static ApiPlatformOptions CreateOptions(int maxLength)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxCorrelationIdLength = maxLength;
        return options;
    }

    private static CorrelationIdMiddleware CreateMiddleware(
        RequestDelegate next,
        ApiPlatformOptions options)
    {
        return new CorrelationIdMiddleware(
            next,
            Options.Create(options),
            NullLogger<CorrelationIdMiddleware>.Instance);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        return context;
    }
}
