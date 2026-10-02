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
    public sealed class RequestLifecycleMiddlewareIntegrationTests
    {
        [Fact]
        public async Task Drain_RejectsOrdinaryRequestBeforeDownstreamExecution()
        {
            var downstreamCalls = 0;
            var fixture = CreateFixture(_ =>
            {
                Interlocked.Increment(ref downstreamCalls);
                return Task.CompletedTask;
            });
            fixture.Coordinator.BeginDrain();
            var context = CreateContext("GET", "/api/layers");

            await fixture.Middleware.InvokeAsync(context);

            Assert.Equal(0, downstreamCalls);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
            Assert.Equal("application/problem+json", context.Response.ContentType);
            Assert.Equal("no-store", context.Response.Headers["Cache-Control"].ToString());
            Assert.Equal("1", context.Response.Headers["Retry-After"].ToString());
            Assert.Equal(1, fixture.Coordinator.RejectedDuringDrain);
            Assert.Equal(0, fixture.Coordinator.InFlight);
            AssertProblemStatus(context, StatusCodes.Status503ServiceUnavailable);
        }

        [Fact]
        public async Task Drain_AllowsHealthProbeAndDoesNotMakeItDrainBlocking()
        {
            var downstreamCalls = 0;
            var fixture = CreateFixture(context =>
            {
                Interlocked.Increment(ref downstreamCalls);
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return Task.CompletedTask;
            });
            fixture.Coordinator.BeginDrain();
            var context = CreateContext("GET", "/health/ready");

            await fixture.Middleware.InvokeAsync(context);

            Assert.Equal(1, downstreamCalls);
            Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
            Assert.Equal(0, fixture.Coordinator.InFlight);
            Assert.Equal(0, fixture.Coordinator.DrainBlockingInFlight);
            Assert.Equal(1, fixture.Coordinator.Accepted);
            Assert.Equal(1, fixture.Coordinator.Completed);
        }

        [Fact]
        public async Task SuccessfulRequest_RestoresOriginalAbortTokenAndCompletesLease()
        {
            using var caller = new CancellationTokenSource();
            var observedToken = CancellationToken.None;
            var fixture = CreateFixture(context =>
            {
                observedToken = context.RequestAborted;
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return Task.CompletedTask;
            });
            var context = CreateContext("GET", "/api/layers");
            context.RequestAborted = caller.Token;

            await fixture.Middleware.InvokeAsync(context);

            Assert.NotEqual(caller.Token, observedToken);
            Assert.Equal(caller.Token, context.RequestAborted);
            Assert.Equal(0, fixture.Coordinator.InFlight);
            Assert.Equal(1, fixture.Coordinator.Completed);
        }

        [Fact]
        public async Task Middleware_PublishesClosedWorkloadAndBudgetMetadataOnly()
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            var context = CreateContext("POST", "/api/import/jobs");

            await fixture.Middleware.InvokeAsync(context);

            Assert.Equal(
                RequestWorkloadClass.Bulk.ToString(),
                context.Items[ApiPlatformDefaults.RequestWorkloadClassItemKey]);
            Assert.Equal(
                60_000L,
                context.Items[ApiPlatformDefaults.RequestTimeoutMillisecondsItemKey]);
            Assert.Equal(2, context.Items.Count);
        }

        [Fact]
        public async Task DownstreamFailure_StillReleasesLifecycleLease()
        {
            var fixture = CreateFixture(_ =>
                throw new InvalidOperationException("expected-test-failure"));
            var context = CreateContext("POST", "/api/layers");

            var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                fixture.Middleware.InvokeAsync(context));

            Assert.Equal("expected-test-failure", exception.Message);
            Assert.Equal(0, fixture.Coordinator.InFlight);
            Assert.Equal(0, fixture.Coordinator.DrainBlockingInFlight);
            Assert.Equal(1, fixture.Coordinator.Completed);
        }

        [Fact]
        public async Task CallerCancellation_IsPropagatedAndDoesNotBecomeGatewayTimeout()
        {
            using var caller = new CancellationTokenSource();
            caller.Cancel();
            var fixture = CreateFixture(context =>
                Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted));
            var context = CreateContext("GET", "/api/layers");
            context.RequestAborted = caller.Token;

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                fixture.Middleware.InvokeAsync(context));

            Assert.NotEqual(StatusCodes.Status504GatewayTimeout, context.Response.StatusCode);
            Assert.Equal(caller.Token, context.RequestAborted);
            Assert.Equal(0, fixture.Coordinator.InFlight);
            Assert.Equal(1, fixture.Coordinator.Completed);
        }

        [Fact]
        public async Task ServerBudgetTimeout_WritesBoundedGatewayTimeoutProblem()
        {
            var options = CreateOptions();
            options.Lifecycle.ReadTimeoutSeconds = 1;
            var fixture = CreateFixture(
                context => Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted),
                options);
            var context = CreateContext("GET", "/api/layers");

            await fixture.Middleware.InvokeAsync(context);

            Assert.Equal(StatusCodes.Status504GatewayTimeout, context.Response.StatusCode);
            Assert.Equal("application/problem+json", context.Response.ContentType);
            Assert.Equal("no-store", context.Response.Headers["Cache-Control"].ToString());
            AssertProblemStatus(context, StatusCodes.Status504GatewayTimeout);
            Assert.Equal(0, fixture.Coordinator.InFlight);
            Assert.Equal(1, fixture.Coordinator.Completed);
        }

        [Theory]
        [InlineData("GET", "/api/layers", "InteractiveRead", 20000L)]
        [InlineData("POST", "/api/layers", "Mutation", 30000L)]
        [InlineData("POST", "/api/import/jobs", "Bulk", 60000L)]
        [InlineData("GET", "/health/live", "Health", 5000L)]
        public async Task Middleware_UsesPolicyBudgetForEveryWorkloadClass(
            string method,
            string path,
            string workload,
            long timeoutMilliseconds)
        {
            var fixture = CreateFixture(_ => Task.CompletedTask);
            var context = CreateContext(method, path);

            await fixture.Middleware.InvokeAsync(context);

            Assert.Equal(
                workload,
                context.Items[ApiPlatformDefaults.RequestWorkloadClassItemKey]);
            Assert.Equal(
                timeoutMilliseconds,
                context.Items[ApiPlatformDefaults.RequestTimeoutMillisecondsItemKey]);
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
            return new MiddlewareFixture(middleware, coordinator, lifetime);
        }

        private static ApiPlatformOptions CreateOptions() => new ApiPlatformOptions();

        private static DefaultHttpContext CreateContext(string method, string path)
        {
            var context = new DefaultHttpContext();
            context.Request.Method = method;
            context.Request.Path = path;
            context.Response.Body = new MemoryStream();
            context.TraceIdentifier = "lifecycle-test-trace";
            return context;
        }

        private static void AssertProblemStatus(DefaultHttpContext context, int expectedStatus)
        {
            context.Response.Body.Position = 0;
            using var document = JsonDocument.Parse(context.Response.Body);
            Assert.Equal(expectedStatus, document.RootElement.GetProperty("status").GetInt32());
        }

        private sealed class MiddlewareFixture
        {
            public MiddlewareFixture(
                RequestLifecycleMiddleware middleware,
                RequestLifecycleCoordinator coordinator,
                TestLifetime lifetime)
            {
                Middleware = middleware;
                Coordinator = coordinator;
                Lifetime = lifetime;
            }

            public RequestLifecycleMiddleware Middleware { get; }
            public RequestLifecycleCoordinator Coordinator { get; }
            public TestLifetime Lifetime { get; }
        }

        private sealed class TestLifetime : IHostApplicationLifetime
        {
            private readonly CancellationTokenSource _stopping = new CancellationTokenSource();

            public CancellationToken ApplicationStarted => CancellationToken.None;
            public CancellationToken ApplicationStopping => _stopping.Token;
            public CancellationToken ApplicationStopped => CancellationToken.None;
            public void StopApplication() => _stopping.Cancel();
        }
    }
}
