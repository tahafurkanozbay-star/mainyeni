using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Hosting;
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleCoordinatorConcurrencyTests
    {
        [Fact]
        public async Task ConcurrentOrdinaryLeases_DrainOnlyAfterEveryLeaseCompletes()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = Enumerable.Range(0, 64).Select(_ => Acquire(coordinator, ReadBudget())).ToArray();

            var drain = coordinator.WaitForDrainAsync(CancellationToken.None);
            Assert.False(drain.IsCompleted);
            Assert.Equal(64, coordinator.InFlight);
            Assert.Equal(64, coordinator.DrainBlockingInFlight);

            await Task.WhenAll(leases.Take(63).Select(lease => Task.Run(lease.Dispose)));
            Assert.False(drain.IsCompleted);
            Assert.Equal(1, coordinator.InFlight);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);

            leases[63].Dispose();
            Assert.True(await drain);
            AssertQuiescent(coordinator, accepted: 64, completed: 64, rejected: 0);
        }

        [Fact]
        public async Task ConcurrentHealthLeases_NeverBecomeDrainBlocking()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = Enumerable.Range(0, 64).Select(_ => Acquire(coordinator, HealthBudget())).ToArray();

            coordinator.BeginDrain();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
            Assert.Equal(64, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);

            await Task.WhenAll(leases.Select(lease => Task.Run(lease.Dispose)));
            AssertQuiescent(coordinator, accepted: 64, completed: 64, rejected: 0);
        }

        [Fact]
        public async Task DrainRace_AdmitsOrRejectsWithoutLeakingAccounting()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var admitted = new ConcurrentBag<RequestLifecycleLease>();
            var start = new ManualResetEventSlim(false);

            var workers = Enumerable.Range(0, 128).Select(_ => Task.Run(() =>
            {
                start.Wait();
                if (coordinator.TryAcquire(ReadBudget(), out var lease)) admitted.Add(lease);
            })).ToArray();
            var drainer = Task.Run(() =>
            {
                start.Wait();
                coordinator.BeginDrain();
            });

            start.Set();
            await Task.WhenAll(workers.Concat(new[] { drainer }));
            Assert.True(coordinator.IsDraining);
            Assert.Equal(128, coordinator.Accepted + coordinator.RejectedDuringDrain);
            Assert.Equal(admitted.Count, coordinator.InFlight);
            Assert.Equal(admitted.Count, coordinator.DrainBlockingInFlight);

            foreach (var lease in admitted) lease.Dispose();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
            AssertQuiescent(coordinator, admitted.Count, admitted.Count, 128 - admitted.Count);
        }

        [Fact]
        public async Task MixedWorkloadRace_HealthRemainsObservableWhileOrdinaryWorkDrains()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var ordinary = Enumerable.Range(0, 32).Select(_ => Acquire(coordinator, MutationBudget())).ToArray();
            coordinator.BeginDrain();
            var health = Enumerable.Range(0, 32).Select(_ => Acquire(coordinator, HealthBudget())).ToArray();

            Assert.Equal(64, coordinator.InFlight);
            Assert.Equal(32, coordinator.DrainBlockingInFlight);
            var wait = coordinator.WaitForDrainAsync(CancellationToken.None);
            Assert.False(wait.IsCompleted);

            await Task.WhenAll(ordinary.Select(lease => Task.Run(lease.Dispose)));
            Assert.True(await wait);
            Assert.Equal(32, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);

            await Task.WhenAll(health.Select(lease => Task.Run(lease.Dispose)));
            AssertQuiescent(coordinator, accepted: 64, completed: 64, rejected: 0);
        }

        [Fact]
        public async Task ConcurrentWaiters_CanHaveIndependentDeadlines()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var lease = Acquire(coordinator, BulkBudget());
            using var cancelled = new CancellationTokenSource();

            var bounded = coordinator.WaitForDrainAsync(cancelled.Token);
            var unbounded = coordinator.WaitForDrainAsync(CancellationToken.None);
            cancelled.Cancel();

            Assert.False(await bounded);
            Assert.False(unbounded.IsCompleted);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);

            lease.Dispose();
            Assert.True(await unbounded);
            AssertQuiescent(coordinator, accepted: 1, completed: 1, rejected: 0);
        }

        [Fact]
        public async Task ManyCancelledWaiters_DoNotCancelSharedDrainCompletion()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var lease = Acquire(coordinator, ReadBudget());
            var cancellationSources = Enumerable.Range(0, 32).Select(_ => new CancellationTokenSource()).ToArray();
            try
            {
                var cancelledWaits = cancellationSources.Select(source => coordinator.WaitForDrainAsync(source.Token)).ToArray();
                var survivor = coordinator.WaitForDrainAsync(CancellationToken.None);
                foreach (var source in cancellationSources) source.Cancel();

                var results = await Task.WhenAll(cancelledWaits);
                Assert.All(results, result => Assert.False(result));
                Assert.False(survivor.IsCompleted);

                lease.Dispose();
                Assert.True(await survivor);
                AssertQuiescent(coordinator, accepted: 1, completed: 1, rejected: 0);
            }
            finally
            {
                foreach (var source in cancellationSources) source.Dispose();
            }
        }

        [Fact]
        public async Task RepeatedBeginDrain_IsIdempotentUnderConcurrency()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var lease = Acquire(coordinator, MutationBudget());

            await Task.WhenAll(Enumerable.Range(0, 128).Select(_ => Task.Run(coordinator.BeginDrain)));
            Assert.True(coordinator.IsDraining);
            Assert.Equal(1, coordinator.InFlight);
            Assert.Equal(1, coordinator.DrainBlockingInFlight);
            Assert.Equal(1, coordinator.Accepted);

            lease.Dispose();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
            AssertQuiescent(coordinator, accepted: 1, completed: 1, rejected: 0);
        }

        [Fact]
        public async Task LeaseDispose_IsIdempotentUnderConcurrency()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var lease = Acquire(coordinator, ReadBudget());

            await Task.WhenAll(Enumerable.Range(0, 128).Select(_ => Task.Run(lease.Dispose)));

            AssertQuiescent(coordinator, accepted: 1, completed: 1, rejected: 0);
            coordinator.BeginDrain();
            Assert.True(await coordinator.WaitForDrainAsync(CancellationToken.None));
        }

        [Fact]
        public async Task Snapshot_RemainsNonNegativeDuringConcurrentRelease()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var leases = Enumerable.Range(0, 128).Select(_ => Acquire(coordinator, ReadBudget())).ToArray();
            var negativeObserved = 0;
            using var stop = new CancellationTokenSource();

            var observer = Task.Run(() =>
            {
                while (!stop.IsCancellationRequested)
                {
                    var snapshot = coordinator.Snapshot;
                    if (snapshot.InFlight < 0 || snapshot.DrainBlockingInFlight < 0 || snapshot.OutstandingAccepted < 0)
                        Interlocked.Exchange(ref negativeObserved, 1);
                }
            });

            await Task.WhenAll(leases.Select(lease => Task.Run(lease.Dispose)));
            stop.Cancel();
            await observer;

            Assert.Equal(0, negativeObserved);
            AssertQuiescent(coordinator, accepted: 128, completed: 128, rejected: 0);
        }

        [Fact]
        public void OrdinaryAcquisitionAfterDrain_IsAlwaysRejected()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            coordinator.BeginDrain();

            Parallel.For(0, 256, _ => Assert.False(coordinator.TryAcquire(ReadBudget(), out _)));

            Assert.Equal(0, coordinator.Accepted);
            Assert.Equal(256, coordinator.RejectedDuringDrain);
            Assert.Equal(0, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        [Fact]
        public void HealthAcquisitionAfterDrain_IsAlwaysAcceptedAndNonBlocking()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            coordinator.BeginDrain();
            var leases = new ConcurrentBag<RequestLifecycleLease>();

            Parallel.For(0, 256, _ =>
            {
                Assert.True(coordinator.TryAcquire(HealthBudget(), out var lease));
                leases.Add(lease);
            });

            Assert.Equal(256, coordinator.Accepted);
            Assert.Equal(0, coordinator.RejectedDuringDrain);
            Assert.Equal(256, coordinator.InFlight);
            Assert.Equal(0, coordinator.DrainBlockingInFlight);
            foreach (var lease in leases) lease.Dispose();
            AssertQuiescent(coordinator, accepted: 256, completed: 256, rejected: 0);
        }

        [Fact]
        public void SnapshotOutstandingAccepted_TracksAcceptedMinusCompleted()
        {
            var coordinator = new RequestLifecycleCoordinator(new TestLifetime());
            var first = Acquire(coordinator, ReadBudget());
            var second = Acquire(coordinator, HealthBudget());
            var third = Acquire(coordinator, BulkBudget());

            Assert.Equal(3, coordinator.Snapshot.OutstandingAccepted);
            second.Dispose();
            Assert.Equal(2, coordinator.Snapshot.OutstandingAccepted);
            first.Dispose();
            Assert.Equal(1, coordinator.Snapshot.OutstandingAccepted);
            third.Dispose();
            Assert.Equal(0, coordinator.Snapshot.OutstandingAccepted);
            Assert.True(coordinator.Snapshot.IsQuiescent);
        }

        private static RequestLifecycleLease Acquire(RequestLifecycleCoordinator coordinator, RequestLifecycleBudget budget)
        {
            Assert.True(coordinator.TryAcquire(budget, out var lease));
            Assert.NotNull(lease);
            return lease;
        }

        private static void AssertQuiescent(RequestLifecycleCoordinator coordinator, long accepted, long completed, long rejected)
        {
            var snapshot = coordinator.Snapshot;
            Assert.Equal(0, snapshot.InFlight);
            Assert.Equal(0, snapshot.DrainBlockingInFlight);
            Assert.Equal(accepted, snapshot.Accepted);
            Assert.Equal(completed, snapshot.Completed);
            Assert.Equal(rejected, snapshot.RejectedDuringDrain);
            Assert.Equal(0, snapshot.OutstandingAccepted);
            Assert.True(snapshot.IsQuiescent);
        }

        private static RequestLifecycleBudget ReadBudget() => new RequestLifecycleBudget(RequestWorkloadClass.InteractiveRead, TimeSpan.FromSeconds(20), false);
        private static RequestLifecycleBudget MutationBudget() => new RequestLifecycleBudget(RequestWorkloadClass.Mutation, TimeSpan.FromSeconds(30), false);
        private static RequestLifecycleBudget BulkBudget() => new RequestLifecycleBudget(RequestWorkloadClass.Bulk, TimeSpan.FromSeconds(60), false);
        private static RequestLifecycleBudget HealthBudget() => new RequestLifecycleBudget(RequestWorkloadClass.Health, TimeSpan.FromSeconds(5), true);

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
