using Microsoft.Extensions.Hosting;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Lifecycle
{
    /// <summary>Aggregate-only authority for accepting and draining request work.</summary>
    public sealed class RequestLifecycleCoordinator
    {
        private readonly object _drainSync = new object();
        private readonly IHostApplicationLifetime _lifetime;
        private TaskCompletionSource<bool> _drainCompletion = CompletedSignal();
        private long _sequence, _inFlight, _drainBlockingInFlight, _accepted, _rejectedDuringDrain, _completed;
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
        public RequestLifecycleSnapshot Snapshot => new RequestLifecycleSnapshot(IsDraining, InFlight, DrainBlockingInFlight, Accepted, Completed, RejectedDuringDrain);

        public bool TryAcquire(RequestLifecycleBudget budget, out RequestLifecycleLease lease)
        {
            lease = null;
            if (IsDraining && !budget.ExemptFromDrain) { Interlocked.Increment(ref _rejectedDuringDrain); return false; }
            Interlocked.Increment(ref _inFlight);
            if (!budget.ExemptFromDrain) AcquireDrainBlockingLease();
            if (IsDraining && !budget.ExemptFromDrain)
            {
                ReleaseCounters(budget, false);
                Interlocked.Increment(ref _rejectedDuringDrain);
                return false;
            }
            Interlocked.Increment(ref _accepted);
            var sequence = Interlocked.Increment(ref _sequence);
            lease = new RequestLifecycleLease(sequence, budget, () => ReleaseCounters(budget, true));
            return true;
        }

        public void BeginDrain()
        {
            if (Interlocked.Exchange(ref _draining, 1) != 0) return;
            lock (_drainSync) if (DrainBlockingInFlight == 0) _drainCompletion.TrySetResult(true);
        }

        public async Task<bool> WaitForDrainAsync(CancellationToken cancellationToken)
        {
            BeginDrain();
            Task drainTask;
            lock (_drainSync) { if (DrainBlockingInFlight == 0) return true; drainTask = _drainCompletion.Task; }
            if (!cancellationToken.CanBeCanceled) { await drainTask.ConfigureAwait(false); return true; }
            var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using (cancellationToken.Register(state => ((TaskCompletionSource<bool>)state).TrySetResult(true), cancelled))
            {
                var winner = await Task.WhenAny(drainTask, cancelled.Task).ConfigureAwait(false);
                if (winner == drainTask) { await drainTask.ConfigureAwait(false); return true; }
            }
            return false;
        }

        private void AcquireDrainBlockingLease()
        {
            lock (_drainSync) if (Interlocked.Increment(ref _drainBlockingInFlight) == 1) _drainCompletion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private void ReleaseCounters(RequestLifecycleBudget budget, bool countCompletion)
        {
            if (Interlocked.Decrement(ref _inFlight) < 0) { Interlocked.Exchange(ref _inFlight, 0); throw new InvalidOperationException("Request lifecycle lease accounting underflowed."); }
            if (!budget.ExemptFromDrain)
            {
                TaskCompletionSource<bool> signal = null;
                lock (_drainSync)
                {
                    var remaining = Interlocked.Decrement(ref _drainBlockingInFlight);
                    if (remaining < 0) { Interlocked.Exchange(ref _drainBlockingInFlight, 0); throw new InvalidOperationException("Request lifecycle drain accounting underflowed."); }
                    if (remaining == 0 && IsDraining) signal = _drainCompletion;
                }
                signal?.TrySetResult(true);
            }
            if (countCompletion) Interlocked.Increment(ref _completed);
        }

        private static TaskCompletionSource<bool> CompletedSignal() { var signal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously); signal.TrySetResult(true); return signal; }
    }

    public readonly struct RequestLifecycleSnapshot
    {
        public RequestLifecycleSnapshot(bool isDraining, long inFlight, long drainBlockingInFlight, long accepted, long completed, long rejectedDuringDrain)
        { IsDraining = isDraining; InFlight = inFlight; DrainBlockingInFlight = drainBlockingInFlight; Accepted = accepted; Completed = completed; RejectedDuringDrain = rejectedDuringDrain; }
        public bool IsDraining { get; }
        public long InFlight { get; }
        public long DrainBlockingInFlight { get; }
        public long Accepted { get; }
        public long Completed { get; }
        public long RejectedDuringDrain { get; }
    }
}
