using Api.Core.Platform;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class SecurityHeadersMiddlewareTests
{
    [Fact]
    public async Task Invoke_AddsSecurityBaselineToHttpsResponse()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.Equal("nosniff", context.Response.Headers["X-Content-Type-Options"].ToString());
        Assert.Equal("DENY", context.Response.Headers["X-Frame-Options"].ToString());
        Assert.Equal("no-referrer", context.Response.Headers["Referrer-Policy"].ToString());
        Assert.Contains("camera=()", context.Response.Headers["Permissions-Policy"].ToString(), StringComparison.Ordinal);
        Assert.Equal("same-origin", context.Response.Headers["Cross-Origin-Resource-Policy"].ToString());
        Assert.Equal("same-origin", context.Response.Headers["Cross-Origin-Opener-Policy"].ToString());
        Assert.Equal(
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            context.Response.Headers["Content-Security-Policy"].ToString());
        Assert.Equal("max-age=31536000; includeSubDomains", context.Response.Headers["Strict-Transport-Security"].ToString());
    }

    [Fact]
    public async Task Invoke_DoesNotEmitHstsForHttpRequest()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext(isHttps: false);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.False(context.Response.Headers.ContainsKey("Strict-Transport-Security"));
        Assert.Equal("nosniff", context.Response.Headers["X-Content-Type-Options"].ToString());
    }

    [Fact]
    public async Task Invoke_DoesNotEmitHstsWhenDisabled()
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.EnableHsts = false;
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.False(context.Response.Headers.ContainsKey("Strict-Transport-Security"));
    }

    [Fact]
    public async Task Invoke_UsesConfiguredHstsMaxAgeAndSubdomainPolicy()
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.HstsMaxAgeSeconds = 600;
        options.SecurityHeaders.HstsIncludeSubDomains = false;
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.Equal("max-age=600", context.Response.Headers["Strict-Transport-Security"].ToString());
    }

    [Fact]
    public async Task Invoke_UsesConfiguredHeaderPolicies()
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.FrameOptions = "SAMEORIGIN";
        options.SecurityHeaders.ReferrerPolicy = "strict-origin";
        options.SecurityHeaders.PermissionsPolicy = "camera=()";
        options.SecurityHeaders.CrossOriginResourcePolicy = "same-site";
        options.SecurityHeaders.CrossOriginOpenerPolicy = "same-origin-allow-popups";
        options.SecurityHeaders.CrossOriginEmbedderPolicy = "require-corp";
        options.SecurityHeaders.ContentSecurityPolicy = "default-src 'self'";
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.Equal("SAMEORIGIN", context.Response.Headers["X-Frame-Options"].ToString());
        Assert.Equal("strict-origin", context.Response.Headers["Referrer-Policy"].ToString());
        Assert.Equal("camera=()", context.Response.Headers["Permissions-Policy"].ToString());
        Assert.Equal("same-site", context.Response.Headers["Cross-Origin-Resource-Policy"].ToString());
        Assert.Equal("same-origin-allow-popups", context.Response.Headers["Cross-Origin-Opener-Policy"].ToString());
        Assert.Equal("require-corp", context.Response.Headers["Cross-Origin-Embedder-Policy"].ToString());
        Assert.Equal("default-src 'self'", context.Response.Headers["Content-Security-Policy"].ToString());
    }

    [Fact]
    public async Task Invoke_OmitsOptionalHeadersWhenConfiguredBlank()
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.CrossOriginEmbedderPolicy = string.Empty;
        options.SecurityHeaders.ContentSecurityPolicy = string.Empty;
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.False(context.Response.Headers.ContainsKey("Cross-Origin-Embedder-Policy"));
        Assert.False(context.Response.Headers.ContainsKey("Content-Security-Policy"));
    }

    [Fact]
    public async Task Invoke_RemovesImplementationDisclosureHeaders()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext(isHttps: true);
        context.Response.Headers["X-Powered-By"] = "legacy-server";
        context.Response.Headers["X-AspNet-Version"] = "legacy-version";
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.False(context.Response.Headers.ContainsKey("X-Powered-By"));
        Assert.False(context.Response.Headers.ContainsKey("X-AspNet-Version"));
    }

    [Fact]
    public async Task Invoke_DoesNothingWhenHeaderBaselineIsDisabled()
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.Enabled = false;
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.False(context.Response.Headers.ContainsKey("X-Content-Type-Options"));
        Assert.False(context.Response.Headers.ContainsKey("X-Frame-Options"));
        Assert.False(context.Response.Headers.ContainsKey("Strict-Transport-Security"));
    }

    [Fact]
    public async Task Invoke_PreservesDownstreamStatusCodeAndBody()
    {
        var options = new ApiPlatformOptions();
        var context = CreateContext(isHttps: true);
        var middleware = CreateMiddleware(async httpContext =>
        {
            httpContext.Response.StatusCode = StatusCodes.Status202Accepted;
            await httpContext.Response.WriteAsync("accepted");
        }, options);

        await middleware.Invoke(context);
        await EnsureResponseStarted(context);

        Assert.Equal(StatusCodes.Status202Accepted, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        using var reader = new StreamReader(context.Response.Body, leaveOpen: true);
        Assert.Equal("accepted", await reader.ReadToEndAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Invoke_ThrowsForNullContext()
    {
        var middleware = CreateMiddleware(_ => Task.CompletedTask, new ApiPlatformOptions());

        await Assert.ThrowsAsync<ArgumentNullException>(() => middleware.Invoke(null!));
    }

    private static SecurityHeadersMiddleware CreateMiddleware(RequestDelegate next, ApiPlatformOptions options)
    {
        return new SecurityHeadersMiddleware(next, Options.Create(options));
    }

    private static DefaultHttpContext CreateContext(bool isHttps)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = isHttps ? "https" : "http";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static Task EnsureResponseStarted(HttpContext context)
    {
        return context.Response.StartAsync();
    }
}
