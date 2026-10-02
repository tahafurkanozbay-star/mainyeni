using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleDrainServiceTests
    {
        [Fact]
        public async Task StopAsync_DisabledLifecycleDoesNotEnterDrain()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = false;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var service = CreateService(coordinator, options);

            await service.StopAsync(CancellationToken.None);

            Assert.False(coordinator.IsDraining);
        }

        [Fact]
        public async Task StopAsync_EmptyLifecycleEntersDrainAndCompletesImmediately()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var service = CreateService(coordinator, new ApiPlatformOptions());

            await service.StopAsync(CancellationToken.None);

            Assert.True(coordinator.IsDraining);
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        [Fact]
        public async Task StopAsync_WaitsForExistingOrdinaryRequestToRelease()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease));
            var service = CreateService(coordinator, new ApiPlatformOptions());

            var stopping = service.StopAsync(CancellationToken.None);
            Assert.False(stopping.IsCompleted);
            Assert.True(coordinator.IsDraining);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);

            lease.Dispose();
            await stopping;

            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            Assert.Equal(1, coordinator.Completed);
        }

        [Fact]
        public async Task StopAsync_HealthRequestCannotExtendDrainDeadline()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            coordinator.BeginDrain();
            Assert.True(coordinator.TryAcquire(HealthBudget(), out var health));
            var service = CreateService(coordinator, new ApiPlatformOptions());

            await service.StopAsync(CancellationToken.None);

            Assert.Equal(1, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            health.Dispose();
        }

        [Fact]
        public async Task StopAsync_HostDeadlineWinsWithoutForcingCounterUnderflow()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(MutationBudget(), out var lease));
            var service = CreateService(coordinator, new ApiPlatformOptions());
            using var hostDeadline = new CancellationTokenSource();
            hostDeadline.Cancel();

            await service.StopAsync(hostDeadline.Token);

            Assert.True(coordinator.IsDraining);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);
            Assert.Equal(1, coordinator.InFlight);
            lease.Dispose();
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            Assert.Equal(0, coordinator.InFlight);
        }

        [Fact]
        public async Task StartAsync_IsSideEffectFree()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var service = CreateService(coordinator, new ApiPlatformOptions());

            await service.StartAsync(CancellationToken.None);

            Assert.False(coordinator.IsDraining);
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        [Fact]
        public async Task StopAsync_RejectsNewOrdinaryWorkWhileExistingLeaseDrains()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var existing));
            var service = CreateService(coordinator, new ApiPlatformOptions());
            using var hostDeadline = new CancellationTokenSource();

            var stop = service.StopAsync(hostDeadline.Token);
            Assert.True(coordinator.IsDraining);
            Assert.False(coordinator.TryAcquire(MutationBudget(), out _));
            Assert.Equal(1, coordinator.RejectedDuringDrain);

            existing.Dispose();
            await stop;
        }

        [Fact]
        public async Task StopAsync_MultipleCallsRemainIdempotentAfterQuiescence()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var service = CreateService(coordinator, new ApiPlatformOptions());

            await service.StopAsync(CancellationToken.None);
            var afterFirst = coordinator.Snapshot;
            await service.StopAsync(CancellationToken.None);
            var afterSecond = coordinator.Snapshot;

            Assert.True(afterFirst.IsDraining);
            Assert.True(afterSecond.IsDraining);
            Assert.Equal(afterFirst.Accepted, afterSecond.Accepted);
            Assert.Equal(afterFirst.Completed, afterSecond.Completed);
            Assert.Equal(afterFirst.RejectedDuringDrain, afterSecond.RejectedDuringDrain);
        }

        private static RequestLifecycleDrainService CreateService(
            RequestLifecycleCoordinator coordinator,
            ApiPlatformOptions options) =>
            new RequestLifecycleDrainService(
                coordinator,
                options,
                NullLogger<RequestLifecycleDrainService>.Instance);

        private static RequestLifecycleBudget ReadBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.InteractiveRead,
                TimeSpan.FromSeconds(1),
                false);

        private static RequestLifecycleBudget MutationBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Mutation,
                TimeSpan.FromSeconds(1),
                false);

        private static RequestLifecycleBudget HealthBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Health,
                TimeSpan.FromSeconds(1),
                true);

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
