using Api.Core.Platform;
using Api.Core.Platform.Health;
using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class PlatformLifecycleReadinessHealthCheckTests
    {
        [Fact]
        public async Task LifecycleReadiness_IsHealthyBeforeDrain()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var check = new LifecycleReadinessHealthCheck(coordinator);

            var result = await check.CheckHealthAsync(new HealthCheckContext());

            Assert.Equal(HealthStatus.Healthy, result.Status);
            Assert.Contains("accepting", result.Description ?? string.Empty, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(false, result.Data["draining"]);
            Assert.Equal(0L, result.Data["inFlight"]);
            Assert.Equal(0L, result.Data["drainBlockingInFlight"]);
            Assert.Equal(0L, result.Data["outstandingAccepted"]);
        }

        [Fact]
        public async Task LifecycleReadiness_BecomesUnhealthyImmediatelyWhenDrainBegins()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var check = new LifecycleReadinessHealthCheck(coordinator);

            coordinator.BeginDrain();
            var result = await check.CheckHealthAsync(new HealthCheckContext());

            Assert.Equal(HealthStatus.Unhealthy, result.Status);
            Assert.Contains("draining", result.Description ?? string.Empty, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(true, result.Data["draining"]);
        }

        [Fact]
        public async Task LifecycleReadiness_ReportsOnlyAggregateBoundedDiagnostics()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var ordinary));
            Assert.True(coordinator.TryAcquire(HealthBudget(), out var health));
            var check = new LifecycleReadinessHealthCheck(coordinator);

            coordinator.BeginDrain();
            var result = await check.CheckHealthAsync(new HealthCheckContext());

            var keys = result.Data.Keys.OrderBy(value => value, StringComparer.Ordinal).ToArray();
            Assert.Equal(
                new[] { "drainBlockingInFlight", "draining", "inFlight", "outstandingAccepted" },
                keys);
            Assert.Equal(2L, result.Data["inFlight"]);
            Assert.Equal(1L, result.Data["drainBlockingInFlight"]);
            Assert.Equal(2L, result.Data["outstandingAccepted"]);
            Assert.DoesNotContain(result.Data.Values, value => value is string);

            ordinary.Dispose();
            health.Dispose();
        }

        [Fact]
        public async Task LifecycleReadiness_HealthLeaseDoesNotRestoreReadinessDuringDrain()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            coordinator.BeginDrain();
            Assert.True(coordinator.TryAcquire(HealthBudget(), out var health));
            var check = new LifecycleReadinessHealthCheck(coordinator);

            var result = await check.CheckHealthAsync(new HealthCheckContext());

            Assert.Equal(HealthStatus.Unhealthy, result.Status);
            Assert.Equal(1L, result.Data["inFlight"]);
            Assert.Equal(0L, result.Data["drainBlockingInFlight"]);
            health.Dispose();
        }

        [Fact]
        public async Task LifecycleReadiness_PreCancelledProbeDoesNotReadStateAsSuccess()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var check = new LifecycleReadinessHealthCheck(coordinator);
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                check.CheckHealthAsync(new HealthCheckContext(), cancellation.Token));
        }

        [Fact]
        public async Task DatabaseReadiness_PreCancelledProbeNeverCreatesDependencyScope()
        {
            var scopeFactory = new CountingScopeFactory();
            var check = new DatabaseHealthCheck(
                scopeFactory,
                Options.Create(new ApiPlatformOptions()));
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                check.CheckHealthAsync(new HealthCheckContext(), cancellation.Token));

            Assert.Equal(0, scopeFactory.CreateScopeCount);
        }

        [Fact]
        public void PlatformRegistration_SeparatesLivenessFromLifecycleAndDatabaseReadiness()
        {
            using var provider = BuildProvider();
            var options = provider
                .GetRequiredService<IOptions<HealthCheckServiceOptions>>()
                .Value;

            var self = options.Registrations.Single(item => item.Name == "self");
            var lifecycle = options.Registrations.Single(
                item => item.Name == ApiPlatformDefaults.LifecycleHealthCheckName);
            var database = options.Registrations.Single(
                item => item.Name == ApiPlatformDefaults.DatabaseHealthCheckName);

            Assert.Contains(ApiPlatformDefaults.LivenessTag, self.Tags);
            Assert.DoesNotContain(ApiPlatformDefaults.ReadinessTag, self.Tags);
            Assert.Contains(ApiPlatformDefaults.ReadinessTag, lifecycle.Tags);
            Assert.DoesNotContain(ApiPlatformDefaults.LivenessTag, lifecycle.Tags);
            Assert.Contains(ApiPlatformDefaults.ReadinessTag, database.Tags);
            Assert.DoesNotContain(ApiPlatformDefaults.LivenessTag, database.Tags);
        }

        [Fact]
        public void PlatformRegistration_UsesUnhealthyFailureStatusForDrainReadiness()
        {
            using var provider = BuildProvider();
            var options = provider
                .GetRequiredService<IOptions<HealthCheckServiceOptions>>()
                .Value;
            var lifecycle = options.Registrations.Single(
                item => item.Name == ApiPlatformDefaults.LifecycleHealthCheckName);

            Assert.Equal(HealthStatus.Unhealthy, lifecycle.FailureStatus);
        }

        private static ServiceProvider BuildProvider()
        {
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ConnectionStrings:Primary"] =
                        "Host=localhost;Database=kent;Username=test;Password=test"
                })
                .Build();
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddKentRehberiApiPlatform(configuration);
            return services.BuildServiceProvider();
        }

        private static RequestLifecycleBudget ReadBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.InteractiveRead,
                TimeSpan.FromSeconds(1),
                false);

        private static RequestLifecycleBudget HealthBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Health,
                TimeSpan.FromSeconds(1),
                true);

        private sealed class CountingScopeFactory : IServiceScopeFactory
        {
            private int _createScopeCount;

            public int CreateScopeCount => Volatile.Read(ref _createScopeCount);

            public IServiceScope CreateScope()
            {
                Interlocked.Increment(ref _createScopeCount);
                throw new InvalidOperationException(
                    "A pre-cancelled database probe must not create a dependency scope.");
            }
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
