using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

/// <summary>
/// Readiness probe for the dedicated Kent Rehberi PostGIS data source.
/// It verifies connection, table visibility and SELECT permission without
/// returning database topology or exception detail to the public health payload.
/// </summary>
public sealed class KentRehberiHealthCheck : IHealthCheck
{
    private const string ProbeSql = """
        SELECT objectid
        FROM kent_rehberi.kent_rehberi_tumu_pggeom
        LIMIT 1
        """;

    private readonly KentRehberiConnectionFactory connectionFactory;
    private readonly KentRehberiOptions options;

    public KentRehberiHealthCheck(
        KentRehberiConnectionFactory connectionFactory,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(options);

        this.connectionFactory = connectionFactory;
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

        if (!connectionFactory.IsConfigured)
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
            await using var connection = connectionFactory.CreateConnection();
            await connection.OpenAsync(timeout.Token);

            await using var command = new NpgsqlCommand(ProbeSql, connection)
            {
                CommandTimeout = Math.Min(
                    options.CommandTimeoutSeconds,
                    options.HealthCheckTimeoutSeconds)
            };

            await command.ExecuteScalarAsync(timeout.Token);
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
        catch (Exception exception)
        {
            stopwatch.Stop();

            return HealthCheckResult.Unhealthy(
                "Kent Rehberi readiness probe failed.",
                exception,
                CreateSafeDiagnosticData(stopwatch.ElapsedMilliseconds));
        }
    }

    private static IReadOnlyDictionary<string, object> CreateSafeDiagnosticData(
        long durationMilliseconds) =>
        new Dictionary<string, object>
        {
            ["durationMs"] = Math.Max(0, durationMilliseconds)
        };
}
