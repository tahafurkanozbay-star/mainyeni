using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

/// <summary>
/// Readiness probe for the configured Kent Rehberi source.
/// PlanASKI mode probes the official HTTPS upstream; PostGIS mode retains the
/// database visibility/SELECT probe. Public health output never includes source
/// URLs, connection topology or exception detail.
/// </summary>
public sealed class KentRehberiHealthCheck : IHealthCheck
{
    private const string ProbeSql = """
        SELECT objectid
        FROM kent_rehberi.kent_rehberi_tumu_pggeom
        LIMIT 1
        """;

    private readonly KentRehberiConnectionFactory connectionFactory;
    private readonly KentRehberiPlanAskiSource planAskiSource;
    private readonly KentRehberiOptions options;

    public KentRehberiHealthCheck(
        KentRehberiConnectionFactory connectionFactory,
        KentRehberiPlanAskiSource planAskiSource,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(planAskiSource);
        ArgumentNullException.ThrowIfNull(options);

        this.connectionFactory = connectionFactory;
        this.planAskiSource = planAskiSource;
        this.options = options;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        if (!options.Enabled)
        {
            return HealthCheckResult.Healthy(
                "Kent Rehberi data source is disabled by configuration.");
        }

        var usePlanAski =
            string.Equals(
                options.Source,
                KentRehberiOptions.PlanAskiSource,
                StringComparison.OrdinalIgnoreCase);

        if (usePlanAski &&
            !planAskiSource.IsConfigured)
        {
            return HealthCheckResult.Unhealthy(
                "Kent Rehberi data source is not configured.");
        }

        if (!usePlanAski &&
            !connectionFactory.IsConfigured)
        {
            return HealthCheckResult.Unhealthy(
                "Kent Rehberi data source is not configured.");
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken);
        timeout.CancelAfter(
            TimeSpan.FromSeconds(options.HealthCheckTimeoutSeconds));

        var stopwatch = Stopwatch.StartNew();

        try
        {
            if (usePlanAski)
            {
                await planAskiSource.ProbeAsync(
                    timeout.Token);
            }
            else
            {
                await using var connection =
                    connectionFactory.CreateConnection();
                await connection.OpenAsync(
                    timeout.Token);

                await using var command =
                    new NpgsqlCommand(
                        ProbeSql,
                        connection)
                    {
                        CommandTimeout = Math.Min(
                            options.CommandTimeoutSeconds,
                            options.HealthCheckTimeoutSeconds)
                    };

                await command.ExecuteScalarAsync(
                    timeout.Token);
            }

            stopwatch.Stop();

            return HealthCheckResult.Healthy(
                "Kent Rehberi data source is reachable.",
                CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds));
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            stopwatch.Stop();

            return HealthCheckResult.Unhealthy(
                "Kent Rehberi readiness probe timed out.",
                data: CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds));
        }
        catch (Exception)
        {
            stopwatch.Stop();

            return HealthCheckResult.Unhealthy(
                "Kent Rehberi readiness probe failed.",
                data: CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds));
        }
    }

    private static IReadOnlyDictionary<string, object> CreateSafeDiagnosticData(
        long durationMilliseconds) =>
        new Dictionary<string, object>
        {
            ["durationMs"] = Math.Max(0, durationMilliseconds)
        };
}
