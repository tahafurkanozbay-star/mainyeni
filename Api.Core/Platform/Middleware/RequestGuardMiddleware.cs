using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Text.Json;
using System.Threading.Tasks;

namespace Api.Core.Platform.Middleware
{
    /// <summary>
    /// Enforces coarse platform-wide request body limits before controllers allocate or parse input.
    /// Endpoint-specific limits may be stricter, but may not silently exceed this platform ceiling.
    /// </summary>
    public sealed class RequestGuardMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly ILogger<RequestGuardMiddleware> _logger;
        private readonly ApiPlatformOptions.RequestOptions _options;

        public RequestGuardMiddleware(
            RequestDelegate next,
            IOptions<ApiPlatformOptions> options,
            ILogger<RequestGuardMiddleware> logger)
        {
            _next = next ?? throw new ArgumentNullException(nameof(next));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _options = options?.Value?.Requests ?? throw new ArgumentNullException(nameof(options));
        }

        public async Task Invoke(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            if (context.Request.ContentLength.HasValue &&
                context.Request.ContentLength.Value > _options.MaxRequestBodyBytes)
            {
                _logger.LogWarning(
                    "Rejected request body with declared length {ContentLength}; limit is {Limit}. Path: {Path}",
                    context.Request.ContentLength.Value,
                    _options.MaxRequestBodyBytes,
                    context.Request.Path);
                await WriteTooLarge(context);
                return;
            }

            var bodySizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (bodySizeFeature != null && !bodySizeFeature.IsReadOnly)
            {
                var existingLimit = bodySizeFeature.MaxRequestBodySize;
                if (!existingLimit.HasValue || existingLimit.Value > _options.MaxRequestBodyBytes)
                {
                    bodySizeFeature.MaxRequestBodySize = _options.MaxRequestBodyBytes;
                }
            }

            await _next(context);
        }

        private async Task WriteTooLarge(HttpContext context)
        {
            if (context.Response.HasStarted)
            {
                return;
            }

            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers.CacheControl = "no-store";

            var payload = new
            {
                type = "about:blank",
                title = "Request payload too large",
                status = StatusCodes.Status413PayloadTooLarge,
                detail = "The request body exceeds the server limit.",
                traceId = context.TraceIdentifier,
                correlationId = context.Items.TryGetValue(ApiPlatformDefaults.TraceIdItemKey, out var id)
                    ? id?.ToString()
                    : null
            };

            await context.Response.WriteAsync(JsonSerializer.Serialize(payload));
        }
    }
}
