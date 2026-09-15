using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Text.Json;
using System.Threading.Tasks;

namespace Api.Core.Platform.Middleware
{
    /// <summary>
    /// Establishes a bounded, log-safe correlation identifier for every request. A caller-provided
    /// identifier is accepted only when it satisfies the shared character/length policy; otherwise
    /// it is rejected or replaced according to server configuration.
    /// </summary>
    public sealed class CorrelationIdMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly ILogger<CorrelationIdMiddleware> _logger;
        private readonly ApiPlatformOptions _options;

        public CorrelationIdMiddleware(
            RequestDelegate next,
            IOptions<ApiPlatformOptions> options,
            ILogger<CorrelationIdMiddleware> logger)
        {
            _next = next ?? throw new ArgumentNullException(nameof(next));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        }

        public async Task Invoke(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var requestOptions = _options.Requests;
            var headerName = requestOptions.CorrelationHeaderName;
            var inbound = context.Request.Headers[headerName].ToString().Trim();

            if (!string.IsNullOrEmpty(inbound) &&
                !ApiPlatformDefaults.IsValidCorrelationId(inbound, requestOptions.MaxCorrelationIdLength))
            {
                if (requestOptions.RejectTraceHeaderWithInvalidCharacters)
                {
                    _logger.LogWarning(
                        "Rejected malformed correlation id on {Method} {Path}.",
                        context.Request.Method,
                        context.Request.Path);
                    await WriteInvalidCorrelationResponse(context);
                    return;
                }

                inbound = string.Empty;
            }

            var correlationId = string.IsNullOrEmpty(inbound)
                ? CreateCorrelationId(context)
                : inbound;

            context.Items[ApiPlatformDefaults.TraceIdItemKey] = correlationId;

            // Set the value immediately so middleware/tests that inspect the response before the
            // server starts it observe the same contract. Re-apply on start so downstream code
            // cannot accidentally replace the server-owned correlation identifier.
            context.Response.Headers[headerName] = correlationId;
            context.Response.OnStarting(() =>
            {
                context.Response.Headers[headerName] = correlationId;
                return Task.CompletedTask;
            });

            using (_logger.BeginScope(new System.Collections.Generic.Dictionary<string, object>
            {
                ["CorrelationId"] = correlationId
            }))
            {
                await _next(context);
            }
        }

        private static string CreateCorrelationId(HttpContext context)
        {
            var traceIdentifier = context.TraceIdentifier?.Trim();
            if (ApiPlatformDefaults.IsValidCorrelationId(traceIdentifier, 96))
            {
                return traceIdentifier;
            }

            return Guid.NewGuid().ToString("N");
        }

        private static async Task WriteInvalidCorrelationResponse(HttpContext context)
        {
            if (context.Response.HasStarted)
            {
                return;
            }

            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers.CacheControl = "no-store";

            var payload = new
            {
                type = "about:blank",
                title = "Invalid request metadata",
                status = StatusCodes.Status400BadRequest,
                detail = "The correlation identifier is malformed."
            };

            await context.Response.WriteAsync(JsonSerializer.Serialize(payload));
        }
    }
}
