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
                ? CreateCorrelationId(context, requestOptions.MaxCorrelationIdLength)
                : inbound;

            context.Items[ApiPlatformDefaults.TraceIdItemKey] = correlationId;

            // Set the header before invoking downstream middleware. This makes the correlation
            // contract visible to short-circuiting middleware/controllers and avoids relying on
            // server-specific OnStarting behavior for a security/observability invariant.
            context.Response.Headers[headerName] = correlationId;

            using (_logger.BeginScope(new System.Collections.Generic.Dictionary<string, object>
            {
                ["CorrelationId"] = correlationId
            }))
            {
                await _next(context);
            }
        }

        private static string CreateCorrelationId(HttpContext context, int maxLength)
        {
            var traceIdentifier = context.TraceIdentifier?.Trim();
            if (ApiPlatformDefaults.IsValidCorrelationId(traceIdentifier, maxLength))
            {
                return traceIdentifier;
            }

            var generated = Guid.NewGuid().ToString("N");
            return generated.Length <= maxLength
                ? generated
                : generated.Substring(0, maxLength);
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
