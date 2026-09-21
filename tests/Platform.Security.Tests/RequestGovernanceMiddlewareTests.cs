using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestGovernanceMiddlewareTests
{
    [Fact]
    public async Task Invoke_AllowsSafeRequestAndPreservesDownstreamStatus()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext("GET", "/api/items");
        var middleware = CreateMiddleware(
            async httpContext =>
            {
                httpContext.Response.StatusCode = StatusCodes.Status204NoContent;
                await Task.CompletedTask;
            },
            options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
    }

    [Fact]
    public async Task Invoke_RejectsTraceBeforeDownstreamExecution()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext("TRACE", "/api/items");
        var nextCalled = false;
        var middleware = CreateMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            options);

        await middleware.Invoke(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status405MethodNotAllowed, context.Response.StatusCode);
        var body = await ReadBody(context);
        Assert.Contains("method-not-allowed", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_RejectsUnsupportedContentTypeWithoutEchoingIt()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext("POST", "/api/items");
        context.Request.ContentLength = 10;
        context.Request.ContentType = "application/xml; profile=secret-value";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, context.Response.StatusCode);
        var body = await ReadBody(context);
        Assert.Contains("unsupported-content-type", body, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-value", body, StringComparison.Ordinal);
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public async Task Invoke_RejectsOversizedHeaderWithoutEchoingValue()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 4096;
        var context = CreateContext("GET", "/api/items");
        context.Request.Headers["X-Large"] = "sensitive-" + new string('x', 5000);
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status431RequestHeaderFieldsTooLarge, context.Response.StatusCode);
        var body = await ReadBody(context);
        Assert.Contains("headers-too-large", body, StringComparison.Ordinal);
        Assert.DoesNotContain("sensitive-", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_IncludesCorrelationAndTraceIdentifiersOnly()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext("TRACE", "/api/items");
        context.Items[ApiPlatformDefaults.TraceIdItemKey] = "corr-123";
        context.TraceIdentifier = "trace-456";
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await middleware.Invoke(context);

        var body = await ReadBody(context);
        Assert.Contains("corr-123", body, StringComparison.Ordinal);
        Assert.Contains("trace-456", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_RejectsGlobalConcurrencyWithRetryAfter()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 1;
        options.Governance.Concurrency.MaxConcurrentPerClient = 1;
        options.Governance.Concurrency.RetryAfterSeconds = 3;
        var governor = new RequestConcurrencyGovernor(options);
        using var occupied = governor.TryAcquire("ip:unknown");

        var context = CreateContext("GET", "/api/items");
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options, governor);

        await middleware.Invoke(context);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal("3", context.Response.Headers.RetryAfter.ToString());
        var body = await ReadBody(context);
        Assert.Contains("global-concurrency-limit", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invoke_RejectsPerClientConcurrencyIndependently()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 10;
        options.Governance.Concurrency.MaxConcurrentPerClient = 1;
        var governor = new RequestConcurrencyGovernor(options);

        var firstContext = CreateContext("GET", "/api/a");
        firstContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");
        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstMiddleware = CreateMiddleware(
            async _ =>
            {
                gate.SetResult(true);
                await release.Task;
            },
            options,
            governor);

        var firstTask = firstMiddleware.Invoke(firstContext);
        await gate.Task;

        var secondContext = CreateContext("GET", "/api/b");
        secondContext.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");
        var secondMiddleware = CreateMiddleware(_ => Task.CompletedTask, options, governor);

        await secondMiddleware.Invoke(secondContext);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, secondContext.Response.StatusCode);
        Assert.Contains(
            "client-concurrency-limit",
            await ReadBody(secondContext),
            StringComparison.Ordinal);

        release.SetResult(true);
        await firstTask;
        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public async Task Invoke_OptionsBypassesConcurrencyByDefault()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 1;
        options.Governance.Concurrency.MaxConcurrentPerClient = 1;
        var governor = new RequestConcurrencyGovernor(options);
        using var occupied = governor.TryAcquire("client:occupied");

        var context = CreateContext("OPTIONS", "/api/items");
        var nextCalled = false;
        var middleware = CreateMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            options,
            governor);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task Invoke_HealthBypassesConcurrencyByDefault()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 1;
        options.Governance.Concurrency.MaxConcurrentPerClient = 1;
        var governor = new RequestConcurrencyGovernor(options);
        using var occupied = governor.TryAcquire("client:occupied");

        var context = CreateContext("GET", "/health/live");
        var nextCalled = false;
        var middleware = CreateMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            options,
            governor);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task Invoke_DisabledGovernanceDoesNotConsumeConcurrency()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        var governor = new RequestConcurrencyGovernor(options);
        var context = CreateContext("TRACE", "/api/../items");
        var nextCalled = false;
        var middleware = CreateMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            options,
            governor);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public async Task Invoke_ReleasesLeaseWhenDownstreamThrows()
    {
        var options = new ApiPlatformOptions();
        var governor = new RequestConcurrencyGovernor(options);
        var context = CreateContext("GET", "/api/items");
        var middleware = CreateMiddleware(
            _ => throw new InvalidOperationException("boom"),
            options,
            governor);

        await Assert.ThrowsAsync<InvalidOperationException>(() => middleware.Invoke(context));

        Assert.Equal(0, governor.ActiveRequests);
    }

    [Fact]
    public async Task Invoke_ThrowsForNullContext()
    {
        var options = new ApiPlatformOptions();
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options);

        await Assert.ThrowsAsync<ArgumentNullException>(() => middleware.Invoke(null!));
    }

    private static RequestGovernanceMiddleware CreateMiddleware(
        RequestDelegate next,
        ApiPlatformOptions options,
        RequestConcurrencyGovernor? governor = null)
    {
        governor ??= new RequestConcurrencyGovernor(options);
        return new RequestGovernanceMiddleware(
            next,
            Options.Create(options),
            governor,
            NullLogger<RequestGovernanceMiddleware>.Instance);
    }

    private static DefaultHttpContext CreateContext(string method, string path)
    {
        var context = new DefaultHttpContext();
        context.RequestServices = new ServiceCollection().BuildServiceProvider();
        context.Request.Method = method;
        context.Request.Path = path;
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
