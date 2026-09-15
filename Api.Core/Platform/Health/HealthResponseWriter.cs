using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace Api.Core.Platform.Health
{
    /// <summary>
    /// Emits a stable, minimal health payload. Exception messages, database hosts, credentials and
    /// dependency response bodies are deliberately excluded from the HTTP response.
    /// </summary>
    public static class HealthResponseWriter
    {
        private static readonly JsonSerializerOptions SerializerOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        public static Task Write(HttpContext context, HealthReport report)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }
            if (report == null)
            {
                throw new ArgumentNullException(nameof(report));
            }

            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.Headers.CacheControl = "no-store, no-cache, max-age=0";
            context.Response.Headers.Pragma = "no-cache";

            var payload = new HealthPayload
            {
                Status = ToPublicStatus(report.Status),
                TotalDurationMs = Math.Max(0, (long)report.TotalDuration.TotalMilliseconds),
                Checks = report.Entries
                    .OrderBy(entry => entry.Key, StringComparer.Ordinal)
                    .Select(entry => new HealthCheckPayload
                    {
                        Name = entry.Key,
                        Status = ToPublicStatus(entry.Value.Status),
                        DurationMs = Math.Max(0, (long)entry.Value.Duration.TotalMilliseconds)
                    })
                    .ToArray()
            };

            return context.Response.WriteAsync(JsonSerializer.Serialize(payload, SerializerOptions));
        }

        private static string ToPublicStatus(HealthStatus status)
        {
            return status switch
            {
                HealthStatus.Healthy => "healthy",
                HealthStatus.Degraded => "degraded",
                _ => "unhealthy"
            };
        }

        private sealed class HealthPayload
        {
            public string Status { get; set; }

            public long TotalDurationMs { get; set; }

            public HealthCheckPayload[] Checks { get; set; }
        }

        private sealed class HealthCheckPayload
        {
            public string Name { get; set; }

            public string Status { get; set; }

            public long DurationMs { get; set; }
        }
    }
}
