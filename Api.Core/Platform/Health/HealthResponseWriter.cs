#nullable enable

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace Api.Core.Platform.Health;

/// <summary>
/// Emits a stable, minimal health payload. Exception messages, database hosts, credentials and
/// dependency response bodies are deliberately excluded from the HTTP response.
/// </summary>
public static class HealthResponseWriter
{
    public static Task Write(HttpContext context, HealthReport report)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(report);

        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store, no-cache, max-age=0";
        context.Response.Headers.Pragma = "no-cache";

        var payload = new HealthResponsePayload(
            ToPublicStatus(report.Status),
            Math.Max(0, (long)report.TotalDuration.TotalMilliseconds),
            report.Entries
                .OrderBy(entry => entry.Key, StringComparer.Ordinal)
                .Select(entry => new HealthCheckResponsePayload(
                    entry.Key,
                    ToPublicStatus(entry.Value.Status),
                    Math.Max(0, (long)entry.Value.Duration.TotalMilliseconds)))
                .ToArray());

        return JsonSerializer.SerializeAsync(
            context.Response.Body,
            payload,
            HealthJsonSerializerContext.Default.HealthResponsePayload,
            context.RequestAborted);
    }

    private static string ToPublicStatus(HealthStatus status) => status switch
    {
        HealthStatus.Healthy => "healthy",
        HealthStatus.Degraded => "degraded",
        _ => "unhealthy"
    };
}
