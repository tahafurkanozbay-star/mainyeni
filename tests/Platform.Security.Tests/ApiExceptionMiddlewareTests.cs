using Api.Core.Platform;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiExceptionMiddlewareTests
{
    [Fact]
    public async Task Invoke_ConvertsUnhandledExceptionToSanitizedProblemResponse()
    {
        var context = CreateContext();
        context.Items[ApiPlatformDefaults.TraceIdItemKey] = "correlation-500";
        const string secretMessage = "database password=do-not-leak";
        var middleware = CreateMiddleware(_ => throw new InvalidOperationException(secretMessage));

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status500InternalServerError, context.Response.StatusCode);
        Assert.Equal("application/problem+json", context.Response.ContentType);
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
        var body = await ReadBody(context);
        Assert.Contains("Internal Server Error", body, StringComparison.Ordinal);
        Assert.Contains(context.TraceIdentifier, body, StringComparison.Ordinal);
        Assert.Contains("correlation-500", body, StringComparison.Ordinal);
        Assert.DoesNotContain(secretMessage, body, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidOperationException", body, StringComparison.Ordinal);
        Assert.DoesNotContain("stack", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Invoke_MapsBadHttpRequestExceptionToClientErrorWithoutRawMessage()
    {
        var context = CreateContext();
        const string rawMessage = "malformed secret-bearing payload";
        var middleware = CreateMiddleware(_ => throw new BadHttpRequestException(rawMessage, StatusCodes.Status422UnprocessableEntity));

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status422UnprocessableEntity, context.Response.StatusCode);
        var body = await ReadBody(context);
        Assert.Contains("Invalid request", body, StringComparison.Ordinal);
        Assert.Contains("HTTP metadata or payload is invalid", body, StringComparison.Ordinal);
        Assert.DoesNotContain(rawMessage, body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_NormalizesUnexpectedBadHttpStatusTo400()
    {
        var context = CreateContext();
        var middleware = CreateMiddleware(_ => throw new BadHttpRequestException("bad", StatusCodes.Status500InternalServerError));

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
    }

    [Fact]
    public async Task Invoke_DoesNotRewriteSuccessfulResponse()
    {
        var context = CreateContext();
        var middleware = CreateMiddleware(async httpContext =>
        {
            httpContext.Response.StatusCode = StatusCodes.Status202Accepted;
            await httpContext.Response.WriteAsync("accepted");
        });

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status202Accepted, context.Response.StatusCode);
        Assert.Equal("accepted", await ReadBody(context));
    }

    [Fact]
    public async Task Invoke_RethrowsUnhandledExceptionAfterResponseHasStarted()
    {
        var context = CreateContext();
        var middleware = CreateMiddleware(async httpContext =>
        {
            await httpContext.Response.StartAsync();
            throw new InvalidOperationException("late failure");
        });

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() => middleware.Invoke(context));

        Assert.Equal("late failure", exception.Message);
    }

    [Fact]
    public async Task Invoke_TreatsClientCancellationAsNonServerFailure()
    {
        using var cancellation = new CancellationTokenSource();
        var context = CreateContext();
        context.RequestAborted = cancellation.Token;
        var middleware = CreateMiddleware(_ =>
        {
            cancellation.Cancel();
            throw new OperationCanceledException(cancellation.Token);
        });

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(string.Empty, await ReadBody(context));
    }

    [Fact]
    public async Task Invoke_DoesNotCatchOperationCanceledExceptionWhenRequestWasNotCancelled()
    {
        var context = CreateContext();
        var middleware = CreateMiddleware(_ => throw new OperationCanceledException("internal cancellation"));

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status500InternalServerError, context.Response.StatusCode);
        var body = await ReadBody(context);
        Assert.DoesNotContain("internal cancellation", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_ProblemPayloadOmitsCorrelationPropertyWhenNoCorrelationMiddlewareRan()
    {
        var context = CreateContext();
        var middleware = CreateMiddleware(_ => throw new Exception("failure"));

        await middleware.Invoke(context);

        var body = await ReadBody(context);
        Assert.DoesNotContain("correlationId", body, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("traceId", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Invoke_ThrowsForNullContext()
    {
        var middleware = CreateMiddleware(_ => Task.CompletedTask);

        await Assert.ThrowsAsync<ArgumentNullException>(() => middleware.Invoke(null!));
    }

    private static ApiExceptionMiddleware CreateMiddleware(RequestDelegate next)
    {
        return new ApiExceptionMiddleware(
            next,
            NullLogger<ApiExceptionMiddleware>.Instance);
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
