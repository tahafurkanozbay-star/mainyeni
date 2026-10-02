using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using System;
using System.Threading;
using System.Threading.Tasks;
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
        { var policy = new RequestLifecyclePolicy(CreateOptions()); var context = new DefaultHttpContext(); context.Request.Method = method; context.Request.Path = path; var budget = policy.Resolve(context); Assert.Equal(expected, budget.WorkloadClass); Assert.Equal(TimeSpan.FromSeconds(seconds), budget.Timeout); Assert.False(budget.ExemptFromDrain); }

        [Theory] [InlineData("/health/live")] [InlineData("/health/ready")]
        public void Resolve_HealthIsShortAndDrainExempt(string path)
        { var policy = new RequestLifecyclePolicy(CreateOptions()); var context = new DefaultHttpContext(); context.Request.Method = "GET"; context.Request.Path = path; var budget = policy.Resolve(context); Assert.Equal(RequestWorkloadClass.Health, budget.WorkloadClass); Assert.Equal(TimeSpan.FromSeconds(5), budget.Timeout); Assert.True(budget.ExemptFromDrain); }

        [Fact] public void Coordinator_RejectsOrdinaryWorkAfterDrainButAllowsHealth()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); coordinator.BeginDrain(); Assert.False(coordinator.TryAcquire(ReadBudget(), out _)); Assert.True(coordinator.TryAcquire(HealthBudget(), out var lease)); Assert.Equal(1, coordinator.InFlight); Assert.Equal(0, coordinator.DrainBlockingInFlight); lease.Dispose(); Assert.Equal(1, coordinator.RejectedDuringDrain); }

        [Fact] public void Lease_IsIdempotentAndCannotUnderflowAccounting()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(MutationBudget(), out var lease)); lease.Dispose(); lease.Dispose(); Assert.Equal(0, coordinator.InFlight); Assert.Equal(0, coordinator.DrainBlockingInFlight); Assert.Equal(1, coordinator.Accepted); Assert.Equal(1, coordinator.Completed); }

        [Fact] public void ApplicationStopping_TransitionsCoordinatorToDrain()
        { var lifetime = new TestLifetime(); var coordinator = new RequestLifecycleCoordinator(lifetime); Assert.False(coordinator.IsDraining); lifetime.Stop(); Assert.True(coordinator.IsDraining); }

        [Fact] public async Task WaitForDrainAsync_CompletesAfterOrdinaryLeaseReleases()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease)); var wait = coordinator.WaitForDrainAsync(CancellationToken.None); Assert.False(wait.IsCompleted); lease.Dispose(); Assert.True(await wait); var snapshot = coordinator.Snapshot; Assert.Equal(0, snapshot.InFlight); Assert.Equal(0, snapshot.DrainBlockingInFlight); Assert.Equal(1, snapshot.Accepted); Assert.Equal(1, snapshot.Completed); }

        [Fact] public async Task WaitForDrainAsync_DoesNotWaitForHealthLease()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); coordinator.BeginDrain(); Assert.True(coordinator.TryAcquire(HealthBudget(), out var health)); Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None)); Assert.Equal(1, coordinator.InFlight); Assert.Equal(0, coordinator.DrainBlockingInFlight); health.Dispose(); }

        [Fact] public async Task WaitForDrainAsync_ReturnsFalseWhenDeadlineWins()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(MutationBudget(), out var lease)); using (var deadline = new CancellationTokenSource()) { var wait = coordinator.WaitForDrainAsync(deadline.Token); deadline.Cancel(); Assert.False(await wait); } Assert.Equal(1, coordinator.DrainBlockingInFlight); lease.Dispose(); }

        [Fact] public async Task WaitForDrainAsync_AlreadyCancelledTokenFailsBoundedly()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease)); using (var deadline = new CancellationTokenSource()) { deadline.Cancel(); Assert.False(await coordinator.WaitForDrainAsync(deadline.Token)); } lease.Dispose(); }

        [Fact] public async Task WaitForDrainAsync_IsIdempotentAcrossConcurrentWaiters()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(ReadBudget(), out var first)); Assert.True(coordinator.TryAcquire(MutationBudget(), out var second)); var one = coordinator.WaitForDrainAsync(CancellationToken.None); var two = coordinator.WaitForDrainAsync(CancellationToken.None); first.Dispose(); Assert.False(one.IsCompleted); second.Dispose(); Assert.True(await one); Assert.True(await two); Assert.Equal(2, coordinator.Completed); }

        [Fact] public async Task Drain_RejectsNewOrdinaryWorkWithoutPerturbingExistingLease()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(ReadBudget(), out var existing)); var wait = coordinator.WaitForDrainAsync(CancellationToken.None); Assert.False(coordinator.TryAcquire(MutationBudget(), out _)); Assert.Equal(1, coordinator.InFlight); Assert.Equal(1, coordinator.RejectedDuringDrain); existing.Dispose(); Assert.True(await wait); }

        [Fact] public void Snapshot_IsAggregateOnlyAndInternallyConsistent()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(ReadBudget(), out var ordinary)); Assert.True(coordinator.TryAcquire(HealthBudget(), out var health)); var active = coordinator.Snapshot; Assert.Equal(2, active.InFlight); Assert.Equal(1, active.DrainBlockingInFlight); Assert.Equal(2, active.Accepted); ordinary.Dispose(); health.Dispose(); var complete = coordinator.Snapshot; Assert.Equal(0, complete.InFlight); Assert.Equal(2, complete.Completed); }

        [Fact] public async Task BeginDrain_WithNoOrdinaryWorkCompletesImmediately()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); coordinator.BeginDrain(); Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None)); Assert.True(coordinator.IsDraining); }

        [Fact] public async Task HealthProbeStartedDuringDrainCannotDelayOrdinaryDrainCompletion()
        { var coordinator = new RequestLifecycleCoordinator(new TestLifetime()); Assert.True(coordinator.TryAcquire(ReadBudget(), out var ordinary)); var wait = coordinator.WaitForDrainAsync(CancellationToken.None); Assert.True(coordinator.TryAcquire(HealthBudget(), out var health)); ordinary.Dispose(); Assert.True(await wait); Assert.Equal(1, coordinator.InFlight); health.Dispose(); }

        private static RequestLifecycleBudget ReadBudget() => new RequestLifecycleBudget(RequestWorkloadClass.InteractiveRead, TimeSpan.FromSeconds(1), false);
        private static RequestLifecycleBudget MutationBudget() => new RequestLifecycleBudget(RequestWorkloadClass.Mutation, TimeSpan.FromSeconds(1), false);
        private static RequestLifecycleBudget HealthBudget() => new RequestLifecycleBudget(RequestWorkloadClass.Health, TimeSpan.FromSeconds(1), true);
        private static ApiPlatformOptions CreateOptions() => new ApiPlatformOptions();
        private sealed class TestLifetime : IHostApplicationLifetime
        { private readonly CancellationTokenSource _stopping = new CancellationTokenSource(); public CancellationToken ApplicationStarted => CancellationToken.None; public CancellationToken ApplicationStopping => _stopping.Token; public CancellationToken ApplicationStopped => CancellationToken.None; public void StopApplication() => Stop(); public void Stop() => _stopping.Cancel(); }
    }
}
