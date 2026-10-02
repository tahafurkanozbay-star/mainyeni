using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Health
{
    /// <summary>
    /// Readiness-only lifecycle probe. Health endpoints remain reachable during drain, but readiness
    /// deliberately turns unhealthy as soon as ordinary work stops being admitted so an upstream
    /// load balancer can remove the instance while liveness continues to observe the process.
    /// </summary>
    public sealed class LifecycleReadinessHealthCheck : IHealthCheck
    {
        private readonly RequestLifecycleCoordinator _coordinator;

        public LifecycleReadinessHealthCheck(RequestLifecycleCoordinator coordinator)
        {
            _coordinator = coordinator ?? throw new ArgumentNullException(nameof(coordinator));
        }

        public Task<HealthCheckResult> CheckHealthAsync(
            HealthCheckContext context,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var snapshot = _coordinator.Snapshot;
            var data = CreateSafeDiagnosticData(snapshot);
            var result = snapshot.IsDraining
                ? HealthCheckResult.Unhealthy(
                    "Application is draining and is not accepting ordinary traffic.",
                    data: data)
                : HealthCheckResult.Healthy(
                    "Application is accepting ordinary traffic.",
                    data);

            return Task.FromResult(result);
        }

        private static IReadOnlyDictionary<string, object> CreateSafeDiagnosticData(
            RequestLifecycleSnapshot snapshot)
        {
            return new Dictionary<string, object>
            {
                ["draining"] = snapshot.IsDraining,
                ["inFlight"] = snapshot.InFlight,
                ["drainBlockingInFlight"] = snapshot.DrainBlockingInFlight,
                ["outstandingAccepted"] = snapshot.OutstandingAccepted
            };
        }
    }
}
