using Microsoft.AspNetCore.Http;
using System;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

namespace Api.Core.Platform.RateLimiting
{
    /// <summary>
    /// Produces bounded-cardinality partition keys for the global API rate limiter.
    /// The resolver never trusts arbitrary request headers directly. Reverse-proxy addresses are
    /// consumed only after ASP.NET Core ForwardedHeadersMiddleware has validated and normalized
    /// the connection according to the configured proxy boundary.
    /// </summary>
    public static class ClientRateLimitPartitioner
    {
        private const string UnknownClientKey = "client:unknown";
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

        public static string ResolvePartitionKey(
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

            var rateLimit = options.RateLimiting ?? new ApiPlatformOptions.RateLimitOptions();

            if (rateLimit.PartitionAuthenticatedUsers)
            {
                var subject = ResolveAuthenticatedSubject(context.User);
                if (!string.IsNullOrWhiteSpace(subject))
                {
                    // A short SHA-256 token avoids retaining account identifiers in limiter keys
                    // while keeping partitions deterministic for the lifetime of the process.
                    return "user:" + HashIdentity(subject);
                }
            }

            var address = NormalizeAddress(context.Connection.RemoteIpAddress);
            if (!string.IsNullOrWhiteSpace(address))
            {
                return "ip:" + address;
            }

            return UnknownClientKey;
        }

        internal static string ResolveAuthenticatedSubject(ClaimsPrincipal principal)
        {
            if (principal?.Identity?.IsAuthenticated != true)
            {
                return null;
            }

            var subject = principal.FindFirst("sub")?.Value;
            if (!string.IsNullOrWhiteSpace(subject))
            {
                return subject.Trim();
            }

            subject = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (!string.IsNullOrWhiteSpace(subject))
            {
                return subject.Trim();
            }

            // Name is deliberately a final fallback because it can be mutable. It is still hashed
            // before being used as a limiter key and is never written to a response or metric tag.
            return string.IsNullOrWhiteSpace(principal.Identity.Name)
                ? null
                : principal.Identity.Name.Trim();
        }

        internal static string NormalizeAddress(IPAddress address)
        {
            if (address == null)
            {
                return null;
            }

            if (address.IsIPv4MappedToIPv6)
            {
                address = address.MapToIPv4();
            }

            return address.ToString().ToLowerInvariant();
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

        private static string HashIdentity(string value)
        {
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
            // 96 bits is more than sufficient for an in-process partition identifier while
            // avoiding unnecessarily long dictionary keys.
            return Convert.ToHexString(bytes.AsSpan(0, 12)).ToLowerInvariant();
        }
    }
}
