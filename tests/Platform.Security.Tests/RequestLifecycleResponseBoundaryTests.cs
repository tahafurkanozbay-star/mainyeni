using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleResponseBoundaryTests
    {
        [Fact]
        public async Task DrainResponse_UsesOnlyServerOwnedCorrelationAuthority()
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext("GET", "/api/layers");
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = "safe-correlation-123";

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(
                "safe-correlation-123",
                document.RootElement.GetProperty("traceId").GetString());
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        }

        [Fact]
        public async Task DrainResponse_DoesNotFallBackToArbitraryTraceIdentifier()
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext("GET", "/api/layers");
            context.TraceIdentifier = "attacker-controlled-but-syntactically-valid";

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("traceId").ValueKind);
            AssertDoesNotLeakHostileRequestData(context);
        }

        [Theory]
        [InlineData("")]
        [InlineData("contains space")]
        [InlineData("contains/slash")]
        [InlineData("contains\\backslash")]
        public async Task DrainResponse_InvalidCorrelationItemIsNotEchoed(string correlationId)
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext("GET", "/api/layers");
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = correlationId;

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("traceId").ValueKind);
            if (!string.IsNullOrEmpty(correlationId))
            {
                Assert.DoesNotContain(correlationId, ReadBody(context), StringComparison.Ordinal);
            }
        }

        [Fact]
        public async Task DrainResponse_OverlongCorrelationItemIsNotEchoed()
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext("GET", "/api/layers");
            var overlong = new string('a', 97);
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = overlong;

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("traceId").ValueKind);
            Assert.DoesNotContain(overlong, ReadBody(context), StringComparison.Ordinal);
        }

        [Fact]
        public async Task DrainResponse_AtBoundaryCorrelationIdIsAccepted()
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext("GET", "/api/layers");
            var boundary = new string('a', 96);
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = boundary;

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(boundary, document.RootElement.GetProperty("traceId").GetString());
        }

        [Fact]
        public async Task TimeoutResponse_UsesOnlyBoundedCorrelationAndClosedWorkload()
        {
            var options = CreateOptions();
            options.Lifecycle.ReadTimeoutSeconds = 1;
            var fixture = CreateFixture(
                context => Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted),
                options);
            var context = CreateHostileContext("GET", "/api/layers");
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = "safe-timeout-correlation";

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(StatusCodes.Status504GatewayTimeout, context.Response.StatusCode);
            Assert.Equal(
                "safe-timeout-correlation",
                document.RootElement.GetProperty("traceId").GetString());
            Assert.Equal(
                RequestWorkloadClass.InteractiveRead.ToString(),
                document.RootElement.GetProperty("workload").GetString());
            AssertDoesNotLeakHostileRequestData(context);
        }

        [Fact]
        public async Task TimeoutResponse_WithoutCorrelationItemDoesNotEchoTraceIdentifier()
        {
            var options = CreateOptions();
            options.Lifecycle.ReadTimeoutSeconds = 1;
            var fixture = CreateFixture(
                context => Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted),
                options);
            var context = CreateHostileContext("GET", "/api/layers");
            context.TraceIdentifier = "untrusted-timeout-trace";

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("traceId").ValueKind);
            Assert.DoesNotContain(
                "untrusted-timeout-trace",
                ReadBody(context),
                StringComparison.Ordinal);
        }

        [Fact]
        public async Task DrainProblemShape_IsSmallAndDeterministic()
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext("POST", "/api/layers");
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = "bounded-id";

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            var root = document.RootElement;
            Assert.Equal(4, root.EnumerateObject().Count());
            Assert.Equal("about:blank", root.GetProperty("type").GetString());
            Assert.Equal("Service is draining", root.GetProperty("title").GetString());
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, root.GetProperty("status").GetInt32());
            Assert.Equal("bounded-id", root.GetProperty("traceId").GetString());
            Assert.True(context.Response.Body.Length < 512);
        }

        [Fact]
        public async Task TimeoutProblemShape_IsSmallAndDeterministic()
        {
            var options = CreateOptions();
            options.Lifecycle.ReadTimeoutSeconds = 1;
            var fixture = CreateFixture(
                context => Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted),
                options);
            var context = CreateHostileContext("GET", "/api/layers");
            context.Items[ApiPlatformDefaults.TraceIdItemKey] = "bounded-id";

            await fixture.Middleware.InvokeAsync(context);

            using var document = ReadJson(context);
            var root = document.RootElement;
            Assert.Equal(5, root.EnumerateObject().Count());
            Assert.Equal("about:blank", root.GetProperty("type").GetString());
            Assert.Equal("Request timed out", root.GetProperty("title").GetString());
            Assert.Equal(StatusCodes.Status504GatewayTimeout, root.GetProperty("status").GetInt32());
            Assert.Equal("InteractiveRead", root.GetProperty("workload").GetString());
            Assert.Equal("bounded-id", root.GetProperty("traceId").GetString());
            Assert.True(context.Response.Body.Length < 512);
        }

        [Theory]
        [InlineData("GET", "/api/layers")]
        [InlineData("POST", "/api/layers")]
        [InlineData("GET", "/api/export")]
        public async Task DrainResponse_SecurityHeadersAreExplicitlyCacheSafe(
            string method,
            string path)
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            fixture.Coordinator.BeginDrain();
            var context = CreateHostileContext(method, path);

            await fixture.Middleware.InvokeAsync(context);

            Assert.Equal("no-store", context.Response.Headers["Cache-Control"].ToString());
            Assert.Equal("1", context.Response.Headers["Retry-After"].ToString());
        }

        private static MiddlewareFixture CreateFixture(
            RequestDelegate next,
            ApiPlatformOptions? options = null)
        {
            options ??= CreateOptions();
            var lifetime = new TestLifetime();
            var coordinator = new RequestLifecycleCoordinator(lifetime);
            var policy = new RequestLifecyclePolicy(options);
            var middleware = new RequestLifecycleMiddleware(
                next,
                policy,
                coordinator,
                NullLogger<RequestLifecycleMiddleware>.Instance);
            return new MiddlewareFixture(middleware, coordinator);
        }

        private static ApiPlatformOptions CreateOptions() => new ApiPlatformOptions();

        private static DefaultHttpContext CreateHostileContext(string method, string path)
        {
            var context = new DefaultHttpContext();
            context.Request.Method = method;
            context.Request.Path = path;
            context.Request.QueryString = new QueryString("?secret=query-secret&operation=export");
            context.Request.Headers["Authorization"] = "Bearer header-secret";
            context.Request.Headers["Cookie"] = "session=cookie-secret";
            context.Request.Headers["X-Client-Secret"] = "custom-header-secret";
            context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes("body-secret"));
            context.Response.Body = new MemoryStream();
            context.TraceIdentifier = "trace-secret-value";
            return context;
        }

        private static JsonDocument ReadJson(DefaultHttpContext context)
        {
            context.Response.Body.Position = 0;
            return JsonDocument.Parse(context.Response.Body);
        }

        private static string ReadBody(DefaultHttpContext context)
        {
            var position = context.Response.Body.Position;
            context.Response.Body.Position = 0;
            using var reader = new StreamReader(
                context.Response.Body,
                Encoding.UTF8,
                detectEncodingFromByteOrderMarks: false,
                bufferSize: 1024,
                leaveOpen: true);
            var body = reader.ReadToEnd();
            context.Response.Body.Position = position;
            return body;
        }

        private static void AssertDoesNotLeakHostileRequestData(DefaultHttpContext context)
        {
            var body = ReadBody(context);
            Assert.DoesNotContain("query-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("header-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("cookie-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("custom-header-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("body-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("trace-secret-value", body, StringComparison.Ordinal);
        }

        private sealed class MiddlewareFixture
        {
            public MiddlewareFixture(
                RequestLifecycleMiddleware middleware,
                RequestLifecycleCoordinator coordinator)
            {
                Middleware = middleware;
                Coordinator = coordinator;
            }

            public RequestLifecycleMiddleware Middleware { get; }
            public RequestLifecycleCoordinator Coordinator { get; }
        }

        private sealed class TestLifetime : IHostApplicationLifetime
        {
            private readonly CancellationTokenSource stopping = new CancellationTokenSource();

            public CancellationToken ApplicationStarted => CancellationToken.None;
            public CancellationToken ApplicationStopping => stopping.Token;
            public CancellationToken ApplicationStopped => CancellationToken.None;
            public void StopApplication() => stopping.Cancel();
        }
    }
}
