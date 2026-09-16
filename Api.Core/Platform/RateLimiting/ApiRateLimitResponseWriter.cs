using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using System;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.RateLimiting
{
    /// <summary>
    /// Writes a deterministic RFC 7807-style response for limiter rejections without leaking
    /// partition keys, IP addresses, account identifiers, or internal limiter state.
    /// </summary>
    public static class ApiRateLimitResponseWriter
    {
        public static ValueTask WriteAsync(
            OnRejectedContext context,
            CancellationToken cancellationToken,
            int fallbackRetryAfterSeconds)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var httpContext = context.HttpContext;
            var response = httpContext.Response;
            var retryAfterSeconds = ResolveRetryAfterSeconds(context, fallbackRetryAfterSeconds);

            response.StatusCode = StatusCodes.Status429TooManyRequests;
            response.ContentType = "application/problem+json";
            response.Headers.CacheControl = "no-store";
            response.Headers["Retry-After"] = retryAfterSeconds.ToString(CultureInfo.InvariantCulture);

            var correlationId = httpContext.Items.TryGetValue(
                ApiPlatformDefaults.TraceIdItemKey,
                out var correlationValue)
                    ? correlationValue?.ToString()
                    : null;

            var payload = new
            {
                type = "https://httpstatuses.com/429",
                title = "Too many requests",
                status = StatusCodes.Status429TooManyRequests,
                detail = "Request rate limit exceeded. Retry after the indicated delay.",
                traceId = httpContext.TraceIdentifier,
                correlationId,
                retryAfterSeconds
            };

            return new ValueTask(response.WriteAsync(
                JsonSerializer.Serialize(payload),
                cancellationToken));
        }

        internal static int ResolveRetryAfterSeconds(
            OnRejectedContext context,
            int fallbackRetryAfterSeconds)
        {
            var fallback = Math.Clamp(fallbackRetryAfterSeconds, 1, 3600);

            if (context?.Lease == null)
            {
                return fallback;
            }

            if (!context.Lease.TryGetMetadata(
                    System.Threading.RateLimiting.MetadataName.RetryAfter,
                    out TimeSpan retryAfter))
            {
                return fallback;
            }

            if (retryAfter <= TimeSpan.Zero)
            {
                return 1;
            }

            return Math.Clamp(
                (int)Math.Ceiling(retryAfter.TotalSeconds),
                1,
                3600);
        }
    }
}
