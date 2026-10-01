using Api.Core.Platform.ClientPartitioning;
using Microsoft.AspNetCore.Http;
using System;

namespace Api.Core.Platform.RateLimiting
{
    /// <summary>
    /// Owns rate-limiter-specific bypass policy. Client identity itself is resolved by
    /// <see cref="ClientPartitionKeyResolver"/> so rate limiting and request concurrency cannot
    /// drift into different trust or privacy semantics.
    /// </summary>
    public static class ClientRateLimitPartitioner
    {
        private const string PreflightKey = "bypass:preflight";
        private const string HealthKey = "bypass:health";

        public static bool ShouldBypass(
            HttpContext context,
            ApiPlatformOptions options)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            var rateLimit = options.RateLimiting;
            if (rateLimit == null || !rateLimit.Enabled)
            {
                return true;
            }

            if (rateLimit.ExemptOptionsRequests &&
                HttpMethods.IsOptions(context.Request.Method))
            {
                return true;
            }

            if (rateLimit.ExemptHealthChecks &&
                IsHealthPath(context.Request.Path, options.Health))
            {
                return true;
            }

            return false;
        }

        public static string ResolveBypassPartition(
            HttpContext context,
            ApiPlatformOptions options)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            if (options.RateLimiting?.ExemptOptionsRequests == true &&
                HttpMethods.IsOptions(context.Request.Method))
            {
                return PreflightKey;
            }

            if (options.RateLimiting?.ExemptHealthChecks == true &&
                IsHealthPath(context.Request.Path, options.Health))
            {
                return HealthKey;
            }

            return "bypass:disabled";
        }

        /// <summary>
        /// Compatibility facade for callers that previously resolved identity through the
        /// rate-limiter type. New platform code should call ClientPartitionKeyResolver directly.
        /// </summary>
        public static string ResolvePartitionKey(
            HttpContext context,
            ApiPlatformOptions options)
        {
            return ClientPartitionKeyResolver.ResolvePartitionKey(context, options);
        }

        internal static bool IsHealthPath(
            PathString requestPath,
            ApiPlatformOptions.HealthOptions health)
        {
            if (health == null || !health.Enabled)
            {
                return false;
            }

            return PathEquals(requestPath, health.LivenessPath) ||
                   PathEquals(requestPath, health.ReadinessPath);
        }

        private static bool PathEquals(PathString requestPath, string configuredPath)
        {
            if (string.IsNullOrWhiteSpace(configuredPath))
            {
                return false;
            }

            return string.Equals(
                requestPath.Value?.TrimEnd('/'),
                configuredPath.Trim().TrimEnd('/'),
                StringComparison.OrdinalIgnoreCase);
        }
    }
}
