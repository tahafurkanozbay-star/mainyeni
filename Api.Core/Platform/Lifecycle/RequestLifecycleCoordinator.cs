using Microsoft.Extensions.Hosting;
using System;
using System.Threading;

namespace Api.Core.Platform.Lifecycle
{
    /// <summary>
    /// Process-local authority for accepting and draining request work. State is deliberately
    /// aggregate-only: no request identifiers, principals, network addresses or payload references
    /// are retained. This makes shutdown accounting bounded and privacy preserving.
    /// </summary>
    public sealed class RequestLifecycleCoordinator
    {
        private readonly IHostApplicationLifetime _lifetime;
        private long _sequence;
        private long _inFlight;
        private long _accepted;
        private long _rejectedDuringDrain;
        private int _draining;

        public RequestLifecycleCoordinator(IHostApplicationLifetime lifetime)
        {
            _lifetime = lifetime ?? throw new ArgumentNullException(nameof(lifetime));
            _lifetime.ApplicationStopping.Register(BeginDrain);
        }

        public bool IsDraining => Volatile.Read(ref _draining) != 0;
        public long InFlight => Interlocked.Read(ref _inFlight);
        public long Accepted => Interlocked.Read(ref _accepted);
        public long RejectedDuringDrain => Interlocked.Read(ref _rejectedDuringDrain);

        public bool TryAcquire(RequestLifecycleBudget budget, out RequestLifecycleLease lease)
        {
            lease = null;
            if (IsDraining && !budget.ExemptFromDrain)
            {
                Interlocked.Increment(ref _rejectedDuringDrain);
                return false;
            }

            Interlocked.Increment(ref _inFlight);
            if (IsDraining && !budget.ExemptFromDrain)
            {
                Interlocked.Decrement(ref _inFlight);
                Interlocked.Increment(ref _rejectedDuringDrain);
                return false;
            }

            Interlocked.Increment(ref _accepted);
            var sequence = Interlocked.Increment(ref _sequence);
            lease = new RequestLifecycleLease(sequence, budget, Release);
            return true;
        }

        public void BeginDrain()
        {
            Interlocked.Exchange(ref _draining, 1);
        }

        private void Release()
        {
            var remaining = Interlocked.Decrement(ref _inFlight);
            if (remaining < 0)
            {
                // Fail closed on accounting corruption while restoring a safe observable value.
                Interlocked.Exchange(ref _inFlight, 0);
                throw new InvalidOperationException("Request lifecycle lease accounting underflowed.");
            }
        }
    }
}
