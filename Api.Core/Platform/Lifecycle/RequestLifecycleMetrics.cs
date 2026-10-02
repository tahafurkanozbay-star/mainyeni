using Microsoft.Extensions.Options;
using System;
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Api.Core.Platform.Lifecycle
{
    /// <summary>
    /// Low-cardinality, payload-free telemetry for the operational request lifecycle authority.
    /// No request path, query, identity, address, header, body, trace id, or arbitrary user value
    /// is retained or emitted. Workload class is a closed enum and outcome values are constants.
    /// </summary>
    public sealed class RequestLifecycleMetrics : IDisposable
    {
        public const string MeterName = "KentRehberi.Api.Lifecycle";
        public const string MeterVersion = "1.0.0";
        private readonly bool enabled;
        private readonly Meter meter;
        private readonly Counter<long> accepted;
        private readonly Counter<long> rejected;
        private readonly Counter<long> completed;
        private readonly Counter<long> timedOut;
        private readonly Counter<long> clientCancelled;
        private readonly Counter<long> drainStarted;
        private readonly Counter<long> drainCompleted;
        private readonly Histogram<double> requestBudget;
        private readonly Histogram<double> drainDuration;
        private readonly Histogram<long> drainInitialInFlight;
        private bool disposed;

        public RequestLifecycleMetrics(IOptions<ApiPlatformOptions> options)
        {
            if (options == null) throw new ArgumentNullException(nameof(options));
            enabled = options.Value?.Diagnostics?.Enabled == true;
            meter = new Meter(MeterName, MeterVersion);
            accepted = meter.CreateCounter<long>("kentrehberi.lifecycle.request.accepted", "{request}", "Requests admitted by lifecycle governance.");
            rejected = meter.CreateCounter<long>("kentrehberi.lifecycle.request.rejected", "{request}", "Requests rejected while the application is draining.");
            completed = meter.CreateCounter<long>("kentrehberi.lifecycle.request.completed", "{request}", "Lifecycle-governed requests whose lease was released.");
            timedOut = meter.CreateCounter<long>("kentrehberi.lifecycle.request.timeout", "{request}", "Lifecycle-governed requests cancelled by their workload budget.");
            clientCancelled = meter.CreateCounter<long>("kentrehberi.lifecycle.request.client_cancelled", "{request}", "Lifecycle-governed requests cancelled by the connected caller.");
            drainStarted = meter.CreateCounter<long>("kentrehberi.lifecycle.drain.started", "{drain}", "Application drain transitions started.");
            drainCompleted = meter.CreateCounter<long>("kentrehberi.lifecycle.drain.completed", "{drain}", "Application drain waits completed, including bounded deadline outcomes.");
            requestBudget = meter.CreateHistogram<double>("kentrehberi.lifecycle.request.budget", "ms", "Configured request execution budget by closed workload class.");
            drainDuration = meter.CreateHistogram<double>("kentrehberi.lifecycle.drain.duration", "ms", "Observed bounded shutdown drain wait duration.");
            drainInitialInFlight = meter.CreateHistogram<long>("kentrehberi.lifecycle.drain.initial_inflight", "{request}", "Drain-blocking requests present when draining starts.");
        }

        public void RequestAccepted(RequestLifecycleBudget budget)
        {
            if (!CanRecord()) return;
            var tags = WorkloadTags(budget.WorkloadClass);
            accepted.Add(1, tags);
            requestBudget.Record(Math.Max(0d, budget.Timeout.TotalMilliseconds), tags);
        }

        public void RequestRejectedDuringDrain(RequestLifecycleBudget budget)
        {
            if (!CanRecord()) return;
            rejected.Add(1, WorkloadTags(budget.WorkloadClass));
        }

        public void RequestCompleted(RequestLifecycleBudget budget)
        {
            if (!CanRecord()) return;
            completed.Add(1, WorkloadTags(budget.WorkloadClass));
        }

        public void RequestTimedOut(RequestLifecycleBudget budget)
        {
            if (!CanRecord()) return;
            timedOut.Add(1, WorkloadTags(budget.WorkloadClass));
        }

        public void RequestClientCancelled(RequestLifecycleBudget budget)
        {
            if (!CanRecord()) return;
            clientCancelled.Add(1, WorkloadTags(budget.WorkloadClass));
        }

        public void DrainStarted(long blockingInFlight)
        {
            if (!CanRecord()) return;
            drainStarted.Add(1);
            drainInitialInFlight.Record(Math.Max(0L, blockingInFlight));
        }

        public void DrainWaitCompleted(bool drained, TimeSpan elapsed)
        {
            if (!CanRecord()) return;
            var tags = new TagList { { "kentrehberi.lifecycle.drain.outcome", drained ? "drained" : "deadline" } };
            drainCompleted.Add(1, tags);
            drainDuration.Record(Math.Max(0d, elapsed.TotalMilliseconds), tags);
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            meter.Dispose();
        }

        internal static TagList WorkloadTags(RequestWorkloadClass workload)
        {
            return new TagList { { "kentrehberi.lifecycle.workload", NormalizeWorkload(workload) } };
        }

        internal static string NormalizeWorkload(RequestWorkloadClass workload)
        {
            switch (workload)
            {
                case RequestWorkloadClass.InteractiveRead: return "read";
                case RequestWorkloadClass.Mutation: return "mutation";
                case RequestWorkloadClass.Bulk: return "bulk";
                case RequestWorkloadClass.Health: return "health";
                default: return "unknown";
            }
        }

        private bool CanRecord()
        {
            return enabled && !disposed;
        }
    }
}
