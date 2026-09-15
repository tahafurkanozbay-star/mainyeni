using System;
using System.Collections.Generic;
using System.Net;

namespace Api.Core.Platform
{
    /// <summary>
    /// Constants and normalization helpers that define the shared API platform contract.
    /// </summary>
    public static class ApiPlatformDefaults
    {
        public const string CorsPolicyName = "SiteCorsPolicy";
        public const string CorrelationHeaderName = "X-Correlation-ID";
        public const string TraceIdItemKey = "KentRehberi.TraceId";
        public const string ReadinessTag = "ready";
        public const string LivenessTag = "live";
        public const string DatabaseHealthCheckName = "database";
        public const string PostgreSqlProvider = "PGSQL";
        public const string PrimaryConnectionStringName = "Primary";

        private static readonly HashSet<char> AllowedCorrelationCharacters = new HashSet<char>(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:".ToCharArray());

        public static string NormalizeProvider(string provider)
        {
            return string.IsNullOrWhiteSpace(provider)
                ? PostgreSqlProvider
                : provider.Trim().ToUpperInvariant();
        }

        public static string NormalizeOrigin(string origin)
        {
            return string.IsNullOrWhiteSpace(origin)
                ? null
                : origin.Trim().TrimEnd('/');
        }

        public static string NormalizePath(string path, string fallback)
        {
            var value = string.IsNullOrWhiteSpace(path) ? fallback : path.Trim();
            if (string.IsNullOrWhiteSpace(value))
            {
                return "/";
            }

            return value.StartsWith("/", StringComparison.Ordinal) ? value : "/" + value;
        }

        public static bool IsValidCorrelationId(string value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value) || maxLength < 1 || value.Length > maxLength)
            {
                return false;
            }

            for (var index = 0; index < value.Length; index++)
            {
                if (!AllowedCorrelationCharacters.Contains(value[index]))
                {
                    return false;
                }
            }

            return true;
        }

        public static bool IsHttpOrigin(string origin, out Uri uri)
        {
            uri = null;
            if (string.IsNullOrWhiteSpace(origin) || !Uri.TryCreate(origin, UriKind.Absolute, out var parsed))
            {
                return false;
            }

            if (!string.Equals(parsed.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!string.IsNullOrEmpty(parsed.Query) || !string.IsNullOrEmpty(parsed.Fragment) ||
                parsed.AbsolutePath != "/")
            {
                return false;
            }

            uri = parsed;
            return true;
        }

        public static bool IsLoopbackHost(Uri uri)
        {
            if (uri == null)
            {
                return false;
            }

            if (string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            var host = uri.Host.Trim('[', ']');
            return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
        }
    }
}
