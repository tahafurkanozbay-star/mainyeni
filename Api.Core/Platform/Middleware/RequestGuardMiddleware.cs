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
            if (bodySizeFeature != null)
            {
                var existingLimit = bodySizeFeature.MaxRequestBodySize;
                var exceedsPlatformCeiling =
                    !existingLimit.HasValue || existingLimit.Value > _options.MaxRequestBodyBytes;

                if (bodySizeFeature.IsReadOnly)
                {
                    if (exceedsPlatformCeiling)
                    {
                        _logger.LogWarning(
                            "Rejected request because body-size enforcement became read-only above the platform limit {Limit}. Path: {Path}",
                            _options.MaxRequestBodyBytes,
                            context.Request.Path);
                        await WriteTooLarge(context);
                        return;
                    }
                }
                else
                {
                    if (exceedsPlatformCeiling)
                    {
                        bodySizeFeature.MaxRequestBodySize = _options.MaxRequestBodyBytes;
                    }

                    // Downstream MVC filters and endpoint metadata can legitimately make the limit
                    // stricter, but they must not raise or disable the platform ceiling after this
                    // middleware has established it. The wrapper delegates every accepted change to
                    // the original server feature so Kestrel remains the actual enforcing authority.
                    context.Features.Set<IHttpMaxRequestBodySizeFeature>(
                        new CappedMaxRequestBodySizeFeature(
                            bodySizeFeature,
                            _options.MaxRequestBodyBytes));
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

        internal sealed class CappedMaxRequestBodySizeFeature : IHttpMaxRequestBodySizeFeature
        {
            private readonly IHttpMaxRequestBodySizeFeature inner;
            private readonly long ceiling;

            public CappedMaxRequestBodySizeFeature(
                IHttpMaxRequestBodySizeFeature inner,
                long ceiling)
            {
                this.inner = inner ?? throw new ArgumentNullException(nameof(inner));
                if (ceiling < 0)
                    throw new ArgumentOutOfRangeException(nameof(ceiling), ceiling, "Request body ceiling cannot be negative.");
                this.ceiling = ceiling;
            }

            public bool IsReadOnly => inner.IsReadOnly;

            public long? MaxRequestBodySize
            {
                get
                {
                    var current = inner.MaxRequestBodySize;
                    return !current.HasValue || current.Value > ceiling
                        ? ceiling
                        : current;
                }
                set
                {
                    if (value.HasValue && value.Value < 0)
                    {
                        // Preserve the server feature's native validation/exception behavior for
                        // invalid negative values rather than silently rewriting caller mistakes.
                        inner.MaxRequestBodySize = value;
                        return;
                    }

                    inner.MaxRequestBodySize = !value.HasValue || value.Value > ceiling
                        ? ceiling
                        : value;
                }
            }
        }
    }
}
