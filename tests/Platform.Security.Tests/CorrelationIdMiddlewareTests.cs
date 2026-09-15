using Api.Core.Platform;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class CorrelationIdMiddlewareTests
{
    [Fact]
    public async Task Invoke_PreservesValidInboundCorrelationId()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.Request.Headers[ApiPlatformDefaults.CorrelationHeaderName] = "client-request-123";

        var nextCalled = false;
        var middleware = CreateMiddleware(async httpContext =>
        {
            nextCalled = true;
            await httpContext.Response.WriteAsync("ok");
        }, options);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
        Assert.Equal("client-request-123", context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal("client-request-123", context.Response.Headers[ApiPlatformDefaults.CorrelationHeaderName].ToString());
        Assert.Equal("ok", await ReadBody(context));
    }

    [Fact]
    public async Task Invoke_UsesSafeTraceIdentifierWhenNoInboundHeaderExists()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.TraceIdentifier = "server-trace-123";

        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);

        Assert.Equal("server-trace-123", context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal("server-trace-123", context.Response.Headers[ApiPlatformDefaults.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task Invoke_GeneratesIdentifierWhenTraceIdentifierIsUnsafe()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.TraceIdentifier = "unsafe trace with spaces";

        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);

        var correlation = Assert.IsType<string>(context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal(32, correlation.Length);
        Assert.True(Guid.TryParseExact(correlation, "N", out _));
        Assert.Equal(correlation, context.Response.Headers[ApiPlatformDefaults.CorrelationHeaderName].ToString());
    }

    [Theory]
    [InlineData("contains space")]
    [InlineData("contains/slash")]
    [InlineData("contains\\slash")]
    [InlineData("contains?query")]
    [InlineData("contains#fragment")]
    [InlineData("line\rreturn")]
    [InlineData("line\nfeed")]
    [InlineData("tab\tvalue")]
    public async Task Invoke_RejectsUnsafeInboundCorrelationId(string inbound)
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.Request.Headers[ApiPlatformDefaults.CorrelationHeaderName] = inbound;

        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal("application/problem+json", context.Response.ContentType);
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
        var body = await ReadBody(context);
        Assert.Contains("Invalid request metadata", body, StringComparison.Ordinal);
        Assert.DoesNotContain(inbound, body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_RejectsIdentifierLongerThanConfiguredLimit()
    {
        var options = CreateOptions();
        options.Requests.MaxCorrelationIdLength = 20;
        var context = CreateContext();
        context.Request.Headers[ApiPlatformDefaults.CorrelationHeaderName] = new string('a', 21);

        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
    }

    [Fact]
    public async Task Invoke_AcceptsIdentifierAtConfiguredLengthBoundary()
    {
        var options = CreateOptions();
        options.Requests.MaxCorrelationIdLength = 20;
        var context = CreateContext();
        var inbound = new string('a', 20);
        context.Request.Headers[ApiPlatformDefaults.CorrelationHeaderName] = inbound;

        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(inbound, context.Response.Headers[ApiPlatformDefaults.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task Invoke_ReplacesInvalidIdentifierWhenStrictRejectionIsDisabled()
    {
        var options = CreateOptions();
        options.Requests.RejectTraceHeaderWithInvalidCharacters = false;
        var context = CreateContext();
        context.TraceIdentifier = "safe-server-trace";
        context.Request.Headers[ApiPlatformDefaults.CorrelationHeaderName] = "unsafe inbound";

        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("safe-server-trace", context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal("safe-server-trace", context.Response.Headers[ApiPlatformDefaults.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task Invoke_UsesConfiguredHeaderName()
    {
        var options = CreateOptions();
        options.Requests.CorrelationHeaderName = "X-Request-ID";
        var context = CreateContext();
        context.Request.Headers["X-Request-ID"] = "custom-header-1";

        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);

        Assert.Equal("custom-header-1", context.Items[ApiPlatformDefaults.TraceIdItemKey]);
        Assert.Equal("custom-header-1", context.Response.Headers["X-Request-ID"].ToString());
        Assert.False(context.Response.Headers.ContainsKey(ApiPlatformDefaults.CorrelationHeaderName));
    }

    [Fact]
    public async Task Invoke_DoesNotExposeCorrelationIdInResponseBody()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.Request.Headers[ApiPlatformDefaults.CorrelationHeaderName] = "sensitive-looking-but-safe-token";

        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("payload"),
            options);

        await middleware.Invoke(context);

        Assert.Equal("payload", await ReadBody(context));
    }

    [Fact]
    public async Task Invoke_PreservesDownstreamStatusCode()
    {
        var options = CreateOptions();
        var context = CreateContext();

        var middleware = CreateMiddleware(async httpContext =>
        {
            httpContext.Response.StatusCode = StatusCodes.Status204NoContent;
            await Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
    }

    [Fact]
    public async Task Invoke_ThrowsForNullContext()
    {
        var middleware = CreateMiddleware(_ => Task.CompletedTask, CreateOptions());

        await Assert.ThrowsAsync<ArgumentNullException>(() => middleware.Invoke(null!));
    }

    private static CorrelationIdMiddleware CreateMiddleware(RequestDelegate next, ApiPlatformOptions options)
    {
        return new CorrelationIdMiddleware(
            next,
            Options.Create(options),
            NullLogger<CorrelationIdMiddleware>.Instance);
    }

    private static ApiPlatformOptions CreateOptions()
    {
        return new ApiPlatformOptions();
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
}
