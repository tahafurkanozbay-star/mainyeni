using Api.Core.Platform.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Security.Cryptography;
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
        private const int GeneratedEntropyBytes = 16;

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
                    // This middleware runs before routing. Do not log Request.Path here: raw path
                    // segments may contain account ids, search text or other unbounded user input.
                    _logger.LogWarning(
                        "Rejected malformed correlation id on {Method}.",
                        ApiRuntimeMetrics.NormalizeMethod(context.Request.Method));
                    await WriteInvalidCorrelationResponse(context);
                    return;
                }

                inbound = string.Empty;
            }

            var correlationId = string.IsNullOrEmpty(inbound)
                ? CreateCorrelationId(context, requestOptions.MaxCorrelationIdLength)
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

        private static string CreateCorrelationId(
            HttpContext context,
            int maxLength)
        {
            var traceIdentifier = context.TraceIdentifier?.Trim();
            if (ApiPlatformDefaults.IsValidCorrelationId(traceIdentifier, maxLength))
            {
                return traceIdentifier;
            }

            Span<byte> entropy = stackalloc byte[GeneratedEntropyBytes];
            RandomNumberGenerator.Fill(entropy);
            var generated = Convert.ToHexString(entropy).ToLowerInvariant();

            // ApiPlatformOptionsValidator constrains this value to [16, 256]. The generated token
            // is 32 hex characters (128 bits) at the default and retains at least 64 bits of entropy
            // at the smallest supported configured ceiling.
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
