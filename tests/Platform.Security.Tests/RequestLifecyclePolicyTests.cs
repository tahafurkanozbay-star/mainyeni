using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using System;
using System.Threading;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecyclePolicyTests
    {
        [Theory]
        [InlineData("GET", "/api/layers", RequestWorkloadClass.InteractiveRead, 20)]
        [InlineData("HEAD", "/api/layers", RequestWorkloadClass.InteractiveRead, 20)]
        [InlineData("POST", "/api/layers", RequestWorkloadClass.Mutation, 30)]
        [InlineData("PATCH", "/api/layers/1", RequestWorkloadClass.Mutation, 30)]
        [InlineData("POST", "/api/layers/export", RequestWorkloadClass.Bulk, 60)]
        [InlineData("PUT", "/api/import/jobs", RequestWorkloadClass.Bulk, 60)]
        public void Resolve_ClassifiesWorkloadDeterministically(string method, string path, RequestWorkloadClass expected, int seconds)
        {
            var policy = new RequestLifecyclePolicy(CreateOptions());
            var context = new DefaultHttpContext(); context.Request.Method = method; context.Request.Path = path;
            var budget = policy.Resolve(context);
            Assert.Equal(expected, budget.WorkloadClass); Assert.Equal(TimeSpan.FromSeconds(seconds), budget.Timeout); Assert.False(budget.ExemptFromDrain);
        }

        [Theory]
        [InlineData("/health/live")]
        [InlineData("/health/ready")]
        public void Resolve_HealthIsShortAndDrainExempt(string path)
        {
            var policy = new RequestLifecyclePolicy(CreateOptions()); var context = new DefaultHttpContext(); context.Request.Method = "GET"; context.Request.Path = path;
            var budget = policy.Resolve(context); Assert.Equal(RequestWorkloadClass.Health, budget.WorkloadClass); Assert.Equal(TimeSpan.FromSeconds(5), budget.Timeout); Assert.True(budget.ExemptFromDrain);
        }

        [Fact]
        public void Coordinator_RejectsOrdinaryWorkAfterDrainButAllowsHealth()
        {
            var lifetime = new TestLifetime(); var coordinator = new RequestLifecycleCoordinator(lifetime);
            coordinator.BeginDrain();
            Assert.False(coordinator.TryAcquire(new RequestLifecycleBudget(RequestWorkloadClass.InteractiveRead, TimeSpan.FromSeconds(1), false), out _));
            Assert.True(coordinator.TryAcquire(new RequestLifecycleBudget(RequestWorkloadClass.Health, TimeSpan.FromSeconds(1), true), out var lease));
            Assert.Equal(1, coordinator.InFlight); lease.Dispose(); Assert.Equal(0, coordinator.InFlight); Assert.Equal(1, coordinator.RejectedDuringDrain);
        }

        [Fact]
        public void Lease_IsIdempotentAndCannotUnderflowAccounting()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(new RequestLifecycleBudget(RequestWorkloadClass.Mutation, TimeSpan.FromSeconds(1), false), out var lease));
            lease.Dispose(); lease.Dispose(); Assert.Equal(0, coordinator.InFlight); Assert.Equal(1, coordinator.Accepted);
        }

        [Fact]
        public void ApplicationStopping_TransitionsCoordinatorToDrain()
        {
            var lifetime = new TestLifetime(); var coordinator = new RequestLifecycleCoordinator(lifetime); Assert.False(coordinator.IsDraining);
            lifetime.Stop(); Assert.True(coordinator.IsDraining);
        }

        private static ApiPlatformOptions CreateOptions() => new ApiPlatformOptions();

        private sealed class TestLifetime : IHostApplicationLifetime
        {
            private readonly CancellationTokenSource _stopping = new CancellationTokenSource();
            public CancellationToken ApplicationStarted => CancellationToken.None;
            public CancellationToken ApplicationStopping => _stopping.Token;
            public CancellationToken ApplicationStopped => CancellationToken.None;
            public void StopApplication() => Stop();
            public void Stop() => _stopping.Cancel();
        }
    }
}
