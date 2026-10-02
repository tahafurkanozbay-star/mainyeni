using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Hosting;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleCoordinatorConcurrencyTests
    {
        [Fact]
        public void ConcurrentOrdinaryAcquireAndRelease_PreservesExactAccounting()
        {
            const int requestCount = 256;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = new ConcurrentBag<RequestLifecycleLease>();
            var failures = new ConcurrentQueue<Exception>();

            Parallel.For(0, requestCount, _ =>
            {
                try
                {
                    Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease));
                    leases.Add(lease);
                }
                catch (Exception exception)
                {
                    failures.Enqueue(exception);
                }
            });

            Assert.Empty(failures);
            Assert.Equal(requestCount, coordinator.InFlight);
            Assert.Equal(requestCount, coordinator.DrainBlockingInFlight);
            Assert.Equal(requestCount, coordinator.Accepted);
            Assert.Equal(0, coordinator.Completed);
            Assert.Equal(requestCount, coordinator.Snapshot.OutstandingAccepted);

            Parallel.ForEach(leases, lease => lease.Dispose());

            Assert.Equal(0, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            Assert.Equal(requestCount, coordinator.Accepted);
            Assert.Equal(requestCount, coordinator.Completed);
            Assert.Equal(0, coordinator.Snapshot.OutstandingAccepted);
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        [Fact]
        public void ConcurrentAcquire_ProducesUniquePositiveLeaseSequences()
        {
            const int requestCount = 256;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = new ConcurrentBag<RequestLifecycleLease>();

            Parallel.For(0, requestCount, _ =>
            {
                if (coordinator.TryAcquire(MutationBudget(), out var lease))
                {
                    leases.Add(lease);
                }
            });

            var sequences = leases.Select(value => value.Sequence).ToArray();
            Assert.Equal(requestCount, sequences.Length);
            Assert.Equal(requestCount, sequences.Distinct().Count());
            Assert.All(sequences, value => Assert.True(value > 0));

            Parallel.ForEach(leases, lease => lease.Dispose());
            Assert.Equal(requestCount, coordinator.Completed);
        }

        [Fact]
        public void ConcurrentBeginDrain_IsIdempotent()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());

            Parallel.For(0, 128, _ => coordinator.BeginDrain());

            var snapshot = coordinator.Snapshot;
            Assert.True(snapshot.IsDraining);
            Assert.True(snapshot.IsQuiescent);
            Assert.Equal(0, snapshot.Accepted);
            Assert.Equal(0, snapshot.Completed);
            Assert.Equal(0, snapshot.RejectedDuringDrain);
        }

        [Fact]
        public void ConcurrentDisposeOfSameLease_IsIdempotent()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease));

            Parallel.For(0, 128, _ => lease.Dispose());

            Assert.Equal(0, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            Assert.Equal(1, coordinator.Accepted);
            Assert.Equal(1, coordinator.Completed);
            Assert.Equal(0, coordinator.Snapshot.OutstandingAccepted);
        }

        [Fact]
        public void ParallelOrdinaryAttemptsAfterDrain_AreRejectedAndCountedExactly()
        {
            const int requestCount = 256;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            coordinator.BeginDrain();
            var unexpectedLeases = new ConcurrentBag<RequestLifecycleLease>();

            Parallel.For(0, requestCount, _ =>
            {
                if (coordinator.TryAcquire(ReadBudget(), out var lease))
                {
                    unexpectedLeases.Add(lease);
                }
            });

            Assert.Empty(unexpectedLeases);
            Assert.Equal(0, coordinator.Accepted);
            Assert.Equal(0, coordinator.Completed);
            Assert.Equal(requestCount, coordinator.RejectedDuringDrain);
            Assert.Equal(0, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
        }

        [Fact]
        public void ParallelHealthRequestsDuringDrain_RemainAcceptedAndNonBlocking()
        {
            const int requestCount = 128;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            coordinator.BeginDrain();

            Parallel.For(0, requestCount, _ =>
            {
                Assert.True(coordinator.TryAcquire(HealthBudget(), out var lease));
                lease.Dispose();
            });

            Assert.Equal(requestCount, coordinator.Accepted);
            Assert.Equal(requestCount, coordinator.Completed);
            Assert.Equal(0, coordinator.RejectedDuringDrain);
            Assert.Equal(0, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
        }

        [Fact]
        public async Task CancelledWaiter_DoesNotPoisonSharedDrainCompletion()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease));
            using var deadline = new CancellationTokenSource();

            var cancelledWaiter = coordinator.WaitForDrainAsync(deadline.Token);
            var successfulWaiter = coordinator.WaitForDrainAsync(CancellationToken.None);
            deadline.Cancel();

            Assert.False(await cancelledWaiter);
            Assert.False(successfulWaiter.IsCompleted);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);

            lease.Dispose();

            Assert.True(await successfulWaiter);
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        [Fact]
        public async Task ManyConcurrentWaiters_CompleteWhenLastOrdinaryLeaseReleases()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var first));
            Assert.True(coordinator.TryAcquire(MutationBudget(), out var second));
            Assert.True(coordinator.TryAcquire(BulkBudget(), out var third));

            var waiters = Enumerable.Range(0, 64)
                .Select(_ => coordinator.WaitForDrainAsync(CancellationToken.None))
                .ToArray();

            first.Dispose();
            second.Dispose();
            Assert.All(waiters, waiter => Assert.False(waiter.IsCompleted));

            third.Dispose();
            var results = await Task.WhenAll(waiters);

            Assert.All(results, Assert.True);
            Assert.Equal(3, coordinator.Accepted);
            Assert.Equal(3, coordinator.Completed);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
        }

        [Fact]
        public async Task HealthLeasesMayRemainActiveAfterOrdinaryDrainCompletes()
        {
            const int healthCount = 32;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var ordinary));
            var healthLeases = new List<RequestLifecycleLease>();

            var wait = coordinator.WaitForDrainAsync(CancellationToken.None);
            for (var index = 0; index < healthCount; index++)
            {
                Assert.True(coordinator.TryAcquire(HealthBudget(), out var health));
                healthLeases.Add(health);
            }

            Assert.Equal(healthCount + 1, coordinator.InFlight);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);
            ordinary.Dispose();

            Assert.True(await wait);
            Assert.Equal(healthCount, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);

            Parallel.ForEach(healthLeases, lease => lease.Dispose());
            Assert.True(coordinator.Snapshot.IsQuiescent);
            Assert.Equal(healthCount + 1, coordinator.Completed);
        }

        [Fact]
        public async Task ConcurrentManualAndHostDrainTransitions_ShareOneState()
        {
            var lifetime = new TestLifetime();
            var coordinator = new RequestLifecycleCoordinator(lifetime);
            Assert.True(coordinator.TryAcquire(MutationBudget(), out var lease));

            var manual = Task.Run(coordinator.BeginDrain);
            var host = Task.Run(lifetime.StopApplication);
            await Task.WhenAll(manual, host);

            Assert.True(coordinator.IsDraining);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);
            Assert.False(coordinator.TryAcquire(ReadBudget(), out _));
            Assert.Equal(1, coordinator.RejectedDuringDrain);

            lease.Dispose();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
            Assert.Equal(1, coordinator.Accepted);
            Assert.Equal(1, coordinator.Completed);
        }

        [Fact]
        public void MixedAcquireDrainRace_PreservesConservationInvariants()
        {
            const int attempts = 512;
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = new ConcurrentBag<RequestLifecycleLease>();

            Parallel.Invoke(
                coordinator.BeginDrain,
                () => Parallel.For(0, attempts, _ =>
                {
                    if (coordinator.TryAcquire(ReadBudget(), out var lease))
                    {
                        leases.Add(lease);
                    }
                }));

            Parallel.ForEach(leases, lease => lease.Dispose());
            var snapshot = coordinator.Snapshot;

            Assert.Equal(attempts, snapshot.Accepted + snapshot.RejectedDuringDrain);
            Assert.Equal(snapshot.Accepted, snapshot.Completed);
            Assert.Equal(0, snapshot.OutstandingAccepted);
            Assert.Equal(0, snapshot.InFlight);
            Assert.Equal(0, snapshot.DrainBlockingInFlight);
            Assert.True(snapshot.IsDraining);
            Assert.True(snapshot.IsQuiescent);
        }

        [Fact]
        public void SnapshotConservation_HoldsAcrossMixedOrdinaryAndHealthWork()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = new List<RequestLifecycleLease>();

            for (var index = 0; index < 10; index++)
            {
                Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease));
                leases.Add(lease);
            }
            for (var index = 0; index < 5; index++)
            {
                Assert.True(coordinator.TryAcquire(HealthBudget(), out var lease));
                leases.Add(lease);
            }

            var active = coordinator.Snapshot;
            Assert.Equal(15, active.Accepted);
            Assert.Equal(0, active.Completed);
            Assert.Equal(15, active.OutstandingAccepted);
            Assert.Equal(15, active.InFlight);
            Assert.Equal(10, active.DrainBlockingInFlight);

            for (var index = 0; index < 7; index++)
            {
                leases[index].Dispose();
            }

            var partial = coordinator.Snapshot;
            Assert.Equal(partial.Accepted - partial.Completed, partial.OutstandingAccepted);
            Assert.Equal(8, partial.OutstandingAccepted);
            Assert.Equal(8, partial.InFlight);
            Assert.Equal(3, partial.DrainBlockingInFlight);

            for (var index = 7; index < leases.Count; index++)
            {
                leases[index].Dispose();
            }

            var complete = coordinator.Snapshot;
            Assert.Equal(15, complete.Accepted);
            Assert.Equal(15, complete.Completed);
            Assert.Equal(0, complete.OutstandingAccepted);
            Assert.True(complete.IsQuiescent);
        }

        [Fact]
        public async Task DeadlineCancellationLeavesLeaseAccountingOwnedByRequest()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(BulkBudget(), out var lease));
            using var deadline = new CancellationTokenSource();
            var wait = coordinator.WaitForDrainAsync(deadline.Token);

            deadline.Cancel();
            Assert.False(await wait);

            var afterDeadline = coordinator.Snapshot;
            Assert.Equal(1, afterDeadline.InFlight);
            Assert.Equal(1, afterDeadline.DrainBlockingInFlight);
            Assert.Equal(1, afterDeadline.OutstandingAccepted);

            lease.Dispose();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        [Fact]
        public async Task RepeatedCancelledWaiters_DoNotAccumulateCoordinatorState()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            Assert.True(coordinator.TryAcquire(ReadBudget(), out var lease));

            for (var index = 0; index < 50; index++)
            {
                using var deadline = new CancellationTokenSource();
                deadline.Cancel();
                Assert.False(await coordinator.WaitForDrainAsync(deadline.Token));
            }

            Assert.Equal(1, coordinator.InFlight);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);
            Assert.Equal(1, coordinator.Accepted);
            Assert.Equal(0, coordinator.Completed);

            lease.Dispose();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
        }

        private static RequestLifecycleBudget ReadBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.InteractiveRead,
                TimeSpan.FromSeconds(20),
                exemptFromDrain: false);

        private static RequestLifecycleBudget MutationBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Mutation,
                TimeSpan.FromSeconds(30),
                exemptFromDrain: false);

        private static RequestLifecycleBudget BulkBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Bulk,
                TimeSpan.FromSeconds(60),
                exemptFromDrain: false);

        private static RequestLifecycleBudget HealthBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Health,
                TimeSpan.FromSeconds(5),
                exemptFromDrain: true);

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
