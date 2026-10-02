using Microsoft.Extensions.Hosting;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Lifecycle
{
    /// <summary>
    /// Process-local authority for accepting and draining request work. State is aggregate-only:
    /// request identifiers, principals, network addresses, bodies and HttpContext references are
    /// never retained. Ordinary work participates in shutdown drain accounting while health probes
    /// remain observable during drain without extending the shutdown deadline.
    /// </summary>
    public sealed class RequestLifecycleCoordinator
    {
        private readonly object _drainSync = new object();
        private readonly IHostApplicationLifetime _lifetime;
        private TaskCompletionSource<bool> _drainCompletion = CompletedSignal();
        private long _sequence;
        private long _inFlight;
        private long _drainBlockingInFlight;
        private long _accepted;
        private long _rejectedDuringDrain;
        private long _completed;
        private int _draining;

        public RequestLifecycleCoordinator(IHostApplicationLifetime lifetime)
        {
            _lifetime = lifetime ?? throw new ArgumentNullException(nameof(lifetime));
            _lifetime.ApplicationStopping.Register(BeginDrain);
        }

        public bool IsDraining => Volatile.Read(ref _draining) != 0;
        public long InFlight => Interlocked.Read(ref _inFlight);
        public long DrainBlockingInFlight => Interlocked.Read(ref _drainBlockingInFlight);
        public long Accepted => Interlocked.Read(ref _accepted);
        public long RejectedDuringDrain => Interlocked.Read(ref _rejectedDuringDrain);
        public long Completed => Interlocked.Read(ref _completed);

        public RequestLifecycleSnapshot Snapshot => new RequestLifecycleSnapshot(
            IsDraining,
            InFlight,
            DrainBlockingInFlight,
            Accepted,
            Completed,
            RejectedDuringDrain);

        public bool TryAcquire(RequestLifecycleBudget budget, out RequestLifecycleLease lease)
        {
            lease = null;
            if (IsDraining && !budget.ExemptFromDrain)
            {
                Interlocked.Increment(ref _rejectedDuringDrain);
                return false;
            }

            Interlocked.Increment(ref _inFlight);
            if (!budget.ExemptFromDrain)
            {
                AcquireDrainBlockingLease();
            }

            // Close the race between the initial drain check and accounting. A request that races
            // ApplicationStopping is rolled back before downstream code can observe a lease.
            if (IsDraining && !budget.ExemptFromDrain)
            {
                ReleaseCounters(budget, countCompletion: false);
                Interlocked.Increment(ref _rejectedDuringDrain);
                return false;
            }

            Interlocked.Increment(ref _accepted);
            var sequence = Interlocked.Increment(ref _sequence);
            lease = new RequestLifecycleLease(sequence, budget, () => ReleaseCounters(budget, countCompletion: true));
            return true;
        }

        public void BeginDrain()
        {
            if (Interlocked.Exchange(ref _draining, 1) != 0)
            {
                return;
            }

            lock (_drainSync)
            {
                if (DrainBlockingInFlight == 0)
                {
                    _drainCompletion.TrySetResult(true);
                }
            }
        }

        /// <summary>
        /// Waits until all ordinary requests accepted before drain have released their leases.
        /// Health requests are deliberately excluded so orchestrator probes cannot hold shutdown
        /// open. The caller owns the deadline through the supplied cancellation token.
        /// </summary>
        public async Task<bool> WaitForDrainAsync(CancellationToken cancellationToken)
        {
            BeginDrain();
            Task drainTask;
            lock (_drainSync)
            {
                if (DrainBlockingInFlight == 0)
                {
                    return true;
                }

                drainTask = _drainCompletion.Task;
            }

            if (!cancellationToken.CanBeCanceled)
            {
                await drainTask.ConfigureAwait(false);
                return true;
            }

            var cancellationSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using (cancellationToken.Register(
                state => ((TaskCompletionSource<bool>)state).TrySetResult(true),
                cancellationSignal))
            {
                var winner = await Task.WhenAny(drainTask, cancellationSignal.Task).ConfigureAwait(false);
                if (winner == drainTask)
                {
                    await drainTask.ConfigureAwait(false);
                    return true;
                }
            }

            return false;
        }

        private void AcquireDrainBlockingLease()
        {
            lock (_drainSync)
            {
                if (Interlocked.Increment(ref _drainBlockingInFlight) == 1)
                {
                    _drainCompletion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                }
            }
        }

        private void ReleaseCounters(RequestLifecycleBudget budget, bool countCompletion)
        {
            var remaining = Interlocked.Decrement(ref _inFlight);
            if (remaining < 0)
            {
                Interlocked.Exchange(ref _inFlight, 0);
                throw new InvalidOperationException("Request lifecycle lease accounting underflowed.");
            }

            if (!budget.ExemptFromDrain)
            {
                TaskCompletionSource<bool> signal = null;
                lock (_drainSync)
                {
                    var drainRemaining = Interlocked.Decrement(ref _drainBlockingInFlight);
                    if (drainRemaining < 0)
                    {
                        Interlocked.Exchange(ref _drainBlockingInFlight, 0);
                        throw new InvalidOperationException("Request lifecycle drain accounting underflowed.");
                    }

                    if (drainRemaining == 0 && IsDraining)
                    {
                        signal = _drainCompletion;
                    }
                }

                signal?.TrySetResult(true);
            }

            if (countCompletion)
            {
                Interlocked.Increment(ref _completed);
            }
        }

        private static TaskCompletionSource<bool> CompletedSignal()
        {
            var signal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            signal.TrySetResult(true);
            return signal;
        }
    }

    public readonly struct RequestLifecycleSnapshot
    {
        public RequestLifecycleSnapshot(
            bool isDraining,
            long inFlight,
            long drainBlockingInFlight,
            long accepted,
            long completed,
            long rejectedDuringDrain)
        {
            IsDraining = isDraining;
            InFlight = inFlight;
            DrainBlockingInFlight = drainBlockingInFlight;
            Accepted = accepted;
            Completed = completed;
            RejectedDuringDrain = rejectedDuringDrain;
        }

        public bool IsDraining { get; }
        public long InFlight { get; }
        public long DrainBlockingInFlight { get; }
        public long Accepted { get; }
        public long Completed { get; }
        public long RejectedDuringDrain { get; }
    }
}
