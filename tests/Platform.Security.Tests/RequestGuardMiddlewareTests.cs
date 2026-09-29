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
        Assert.Equal(2048, context.Features.Get<IHttpMaxRequestBodySizeFeature>()?.MaxRequestBodySize);
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
        Assert.Equal(4096, context.Features.Get<IHttpMaxRequestBodySizeFeature>()?.MaxRequestBodySize);
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
        Assert.Equal(1024, context.Features.Get<IHttpMaxRequestBodySizeFeature>()?.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_DownstreamCannotRaiseServerBodyFeatureAbovePlatformCeiling()
    {
        var options = CreateOptions(maxBytes: 2048);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 10_000,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(httpContext =>
        {
            var guarded = httpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            Assert.NotNull(guarded);
            guarded.MaxRequestBodySize = 50_000;
            Assert.Equal(2048, guarded.MaxRequestBodySize);
            Assert.Equal(2048, feature.MaxRequestBodySize);
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.Equal(2048, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_DownstreamCannotDisablePlatformBodyCeilingWithUnlimitedValue()
    {
        var options = CreateOptions(maxBytes: 2048);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 2048,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(httpContext =>
        {
            var guarded = httpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            Assert.NotNull(guarded);
            guarded.MaxRequestBodySize = null;
            Assert.Equal(2048, guarded.MaxRequestBodySize);
            Assert.Equal(2048, feature.MaxRequestBodySize);
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.Equal(2048, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_DownstreamCanTightenPlatformBodyCeiling()
    {
        var options = CreateOptions(maxBytes: 2048);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 10_000,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(httpContext =>
        {
            var guarded = httpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            Assert.NotNull(guarded);
            guarded.MaxRequestBodySize = 512;
            Assert.Equal(512, guarded.MaxRequestBodySize);
            Assert.Equal(512, feature.MaxRequestBodySize);
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.Equal(512, feature.MaxRequestBodySize);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1025L)]
    [InlineData(10_000L)]
    public async Task Invoke_RejectsReadOnlyServerBodyFeatureAbovePlatformCeiling(long? existingLimit)
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = existingLimit,
            IsReadOnlyValue = true
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        Assert.Equal(existingLimit, feature.MaxRequestBodySize);
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(512L)]
    [InlineData(1024L)]
    public async Task Invoke_AllowsReadOnlyServerBodyFeatureAtOrBelowPlatformCeiling(long existingLimit)
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = existingLimit,
            IsReadOnlyValue = true
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var nextCalled = false;
        var middleware = CreateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.True(nextCalled);
        Assert.Equal(existingLimit, feature.MaxRequestBodySize);
        Assert.NotEqual(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
    }

    [Fact]
    public async Task Invoke_PreservesServerValidationForNegativeDownstreamLimit()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 1024,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(httpContext =>
        {
            var guarded = httpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            Assert.NotNull(guarded);
            guarded.MaxRequestBodySize = -1;
            return Task.CompletedTask;
        }, options);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => middleware.Invoke(context));
        Assert.Equal(1024, feature.MaxRequestBodySize);
    }

    [Fact]
    public async Task Invoke_ReflectsFeatureBecomingReadOnlyDownstream()
    {
        var options = CreateOptions(maxBytes: 1024);
        var context = CreateContext();
        var feature = new MutableBodySizeFeature
        {
            MaxRequestBodySize = 1024,
            IsReadOnlyValue = false
        };
        context.Features.Set<IHttpMaxRequestBodySizeFeature>(feature);
        var middleware = CreateMiddleware(httpContext =>
        {
            var guarded = httpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            Assert.NotNull(guarded);
            feature.IsReadOnlyValue = true;
            Assert.True(guarded.IsReadOnly);
            Assert.Throws<InvalidOperationException>(() => guarded.MaxRequestBodySize = 512);
            return Task.CompletedTask;
        }, options);

        await middleware.Invoke(context);

        Assert.Equal(1024, feature.MaxRequestBodySize);
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
        private long? maxRequestBodySize;

        public bool IsReadOnly => IsReadOnlyValue;

        public bool IsReadOnlyValue { get; set; }

        public long? MaxRequestBodySize
        {
            get => maxRequestBodySize;
            set
            {
                if (IsReadOnlyValue)
                    throw new InvalidOperationException("The request body size feature is read-only.");
                if (value.HasValue && value.Value < 0)
                    throw new ArgumentOutOfRangeException(nameof(value));
                maxRequestBodySize = value;
            }
        }
    }
}
