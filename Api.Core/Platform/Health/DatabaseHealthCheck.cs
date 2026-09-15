using Business.Core.Context;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Health
{
    /// <summary>
    /// Readiness check for PostgreSQL connectivity. A fresh DI scope is created for each probe so
    /// pooled DbContext lifetimes are respected and the health-check singleton never captures one.
    /// </summary>
    public sealed class DatabaseHealthCheck : IHealthCheck
    {
        private readonly IServiceScopeFactory _scopeFactory;
        private readonly ApiPlatformOptions.HealthOptions _options;

        public DatabaseHealthCheck(
            IServiceScopeFactory scopeFactory,
            IOptions<ApiPlatformOptions> options)
        {
            _scopeFactory = scopeFactory ?? throw new ArgumentNullException(nameof(scopeFactory));
            _options = options?.Value?.Health ?? throw new ArgumentNullException(nameof(options));
        }

        public async Task<HealthCheckResult> CheckHealthAsync(
            HealthCheckContext context,
            CancellationToken cancellationToken = default)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(_options.DatabaseTimeoutSeconds));

            var stopwatch = Stopwatch.StartNew();
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var database = scope.ServiceProvider.GetRequiredService<BusinessContext>();
                var canConnect = await database.Database.CanConnectAsync(timeout.Token);
                stopwatch.Stop();

                var data = CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds);
                return canConnect
                    ? HealthCheckResult.Healthy("Database is reachable.", data)
                    : HealthCheckResult.Unhealthy("Database is not reachable.", data: data);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                stopwatch.Stop();
                return HealthCheckResult.Unhealthy(
                    "Database readiness probe timed out.",
                    data: CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds));
            }
            catch (Exception exception)
            {
                stopwatch.Stop();
                // The public health response intentionally omits the exception. HealthCheckResult
                // retains it for server-side logging/diagnostics only.
                return HealthCheckResult.Unhealthy(
                    "Database readiness probe failed.",
                    exception,
                    CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds));
            }
        }

        private static IReadOnlyDictionary<string, object> CreateSafeDiagnosticData(long durationMilliseconds)
        {
            return new Dictionary<string, object>
            {
                ["durationMs"] = durationMilliseconds
            };
        }
    }
}
