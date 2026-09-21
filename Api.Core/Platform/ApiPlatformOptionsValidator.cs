using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Api.Core.Platform
{
    /// <summary>
    /// Validates operational platform settings before request processing begins. Invalid security,
    /// timeout, limiter or health endpoint configuration fails closed instead of degrading silently.
    /// </summary>
    public sealed class ApiPlatformOptionsValidator : IValidateOptions<ApiPlatformOptions>
    {
        private static readonly HashSet<string> SupportedMethods = new HashSet<string>(
            new[] { "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD" },
            StringComparer.OrdinalIgnoreCase);

        public ValidateOptionsResult Validate(string name, ApiPlatformOptions options)
        {
            if (options == null)
            {
                return ValidateOptionsResult.Fail("Platform configuration is required.");
            }

            var failures = new List<string>();
            ValidateDatabase(options.Database, failures);
            ValidateCors(options.Cors, failures);
            ValidateRequests(options.Requests, failures);
            ValidateHeaders(options.SecurityHeaders, failures);
            ValidateHealth(options.Health, failures);
            ValidateForwardedHeaders(options.ForwardedHeaders, failures);
            ValidateRateLimiting(options.RateLimiting, failures);
            ValidateResponseCompression(options.ResponseCompression, failures);
            ValidateDiagnostics(options.Diagnostics, failures);
            ValidateGovernance(options.Governance, failures);

            return failures.Count == 0
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(failures);
        }

        private static void ValidateDatabase(
            ApiPlatformOptions.DatabaseOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:Database configuration is required.");
                return;
            }

            if (!string.Equals(
                    ApiPlatformDefaults.NormalizeProvider(options.Provider),
                    ApiPlatformDefaults.PostgreSqlProvider,
                    StringComparison.OrdinalIgnoreCase))
            {
                failures.Add("Platform:Database:Provider must be PGSQL for the active runtime.");
            }

            if (options.CommandTimeoutSeconds < 1 || options.CommandTimeoutSeconds > 300)
            {
                failures.Add("Platform:Database:CommandTimeoutSeconds must be between 1 and 300.");
            }

            if (options.RetryCount < 0 || options.RetryCount > 10)
            {
                failures.Add("Platform:Database:RetryCount must be between 0 and 10.");
            }

            if (options.RetryMaxDelaySeconds < 1 || options.RetryMaxDelaySeconds > 60)
            {
                failures.Add("Platform:Database:RetryMaxDelaySeconds must be between 1 and 60.");
            }
        }

        private static void ValidateCors(
            ApiPlatformOptions.CorsOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:Cors configuration is required.");
                return;
            }

            var origins = options.AllowedOrigins ?? Array.Empty<string>();
            foreach (var rawOrigin in origins)
            {
                var origin = ApiPlatformDefaults.NormalizeOrigin(rawOrigin);
                if (string.IsNullOrWhiteSpace(origin))
                {
                    failures.Add("Platform:Cors:AllowedOrigins cannot contain blank values.");
                    continue;
                }

                if (origin == "*")
                {
                    failures.Add("Wildcard CORS origins are not supported.");
                    continue;
                }

                if (!ApiPlatformDefaults.IsHttpOrigin(origin, out _))
                {
                    failures.Add($"CORS origin '{origin}' must be an absolute HTTP(S) origin without path, query or fragment.");
                }
            }

            if (options.AllowedMethods == null || options.AllowedMethods.Count == 0)
            {
                failures.Add("Platform:Cors:AllowedMethods must contain at least one method.");
            }
            else
            {
                foreach (var method in options.AllowedMethods)
                {
                    if (string.IsNullOrWhiteSpace(method) || !SupportedMethods.Contains(method.Trim()))
                    {
                        failures.Add($"Unsupported CORS method '{method ?? "<null>"}'.");
                    }
                }
            }

            if (options.AllowedHeaders == null || options.AllowedHeaders.Count == 0)
            {
                failures.Add("Platform:Cors:AllowedHeaders must contain at least one header.");
            }
            else if (options.AllowedHeaders.Any(header => string.IsNullOrWhiteSpace(header)))
            {
                failures.Add("Platform:Cors:AllowedHeaders cannot contain blank values.");
            }
        }

        private static void ValidateRequests(
            ApiPlatformOptions.RequestOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:Requests configuration is required.");
                return;
            }

            if (options.TimeoutSeconds < 1 || options.TimeoutSeconds > 300)
            {
                failures.Add("Platform:Requests:TimeoutSeconds must be between 1 and 300.");
            }

            if (options.MaxRequestBodyBytes < 1024 || options.MaxRequestBodyBytes > 100L * 1024 * 1024)
            {
                failures.Add("Platform:Requests:MaxRequestBodyBytes must be between 1 KiB and 100 MiB.");
            }

            if (options.MaxCorrelationIdLength < 16 || options.MaxCorrelationIdLength > 256)
            {
                failures.Add("Platform:Requests:MaxCorrelationIdLength must be between 16 and 256.");
            }

            if (string.IsNullOrWhiteSpace(options.CorrelationHeaderName))
            {
                failures.Add("Platform:Requests:CorrelationHeaderName is required.");
            }
            else if (!IsValidHeaderName(options.CorrelationHeaderName))
            {
                failures.Add("Platform:Requests:CorrelationHeaderName contains invalid characters.");
            }
        }

        private static void ValidateHeaders(
            ApiPlatformOptions.SecurityHeaderOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:SecurityHeaders configuration is required.");
                return;
            }

            if (!options.Enabled)
            {
                return;
            }

            if (options.EnableHsts && (options.HstsMaxAgeSeconds < 0 || options.HstsMaxAgeSeconds > 63072000))
            {
                failures.Add("Platform:SecurityHeaders:HstsMaxAgeSeconds must be between 0 and 63072000.");
            }

            ValidateSingleLineHeader(options.FrameOptions, "FrameOptions", failures);
            ValidateSingleLineHeader(options.ReferrerPolicy, "ReferrerPolicy", failures);
            ValidateSingleLineHeader(options.PermissionsPolicy, "PermissionsPolicy", failures);
            ValidateSingleLineHeader(options.CrossOriginResourcePolicy, "CrossOriginResourcePolicy", failures);
            ValidateSingleLineHeader(options.CrossOriginOpenerPolicy, "CrossOriginOpenerPolicy", failures);
            ValidateSingleLineHeader(options.CrossOriginEmbedderPolicy, "CrossOriginEmbedderPolicy", failures, allowEmpty: true);
            ValidateSingleLineHeader(options.ContentSecurityPolicy, "ContentSecurityPolicy", failures, allowEmpty: true);
        }

        private static void ValidateHealth(
            ApiPlatformOptions.HealthOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:Health configuration is required.");
                return;
            }

            if (!options.Enabled)
            {
                return;
            }

            if (!IsSafeEndpointPath(options.LivenessPath))
            {
                failures.Add("Platform:Health:LivenessPath must be a local absolute path.");
            }

            if (!IsSafeEndpointPath(options.ReadinessPath))
            {
                failures.Add("Platform:Health:ReadinessPath must be a local absolute path.");
            }

            if (string.Equals(options.LivenessPath, options.ReadinessPath, StringComparison.OrdinalIgnoreCase))
            {
                failures.Add("Liveness and readiness paths must be different.");
            }

            if (options.DatabaseTimeoutSeconds < 1 || options.DatabaseTimeoutSeconds > 30)
            {
                failures.Add("Platform:Health:DatabaseTimeoutSeconds must be between 1 and 30.");
            }
        }

        private static void ValidateForwardedHeaders(
            ApiPlatformOptions.ForwardedHeaderOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:ForwardedHeaders configuration is required.");
                return;
            }

            if (options.Enabled && (options.ForwardLimit < 1 || options.ForwardLimit > 5))
            {
                failures.Add("Platform:ForwardedHeaders:ForwardLimit must be between 1 and 5.");
            }
        }

        private static void ValidateRateLimiting(
            ApiPlatformOptions.RateLimitOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:RateLimiting configuration is required.");
                return;
            }

            if (!options.Enabled)
            {
                return;
            }

            if (options.PermitLimit < 1 || options.PermitLimit > 10000)
            {
                failures.Add("Platform:RateLimiting:PermitLimit must be between 1 and 10000.");
            }

            if (options.WindowSeconds < 1 || options.WindowSeconds > 3600)
            {
                failures.Add("Platform:RateLimiting:WindowSeconds must be between 1 and 3600.");
            }

            if (options.SegmentsPerWindow < 1 || options.SegmentsPerWindow > 60)
            {
                failures.Add("Platform:RateLimiting:SegmentsPerWindow must be between 1 and 60.");
            }
            else if (options.WindowSeconds >= 1 && options.SegmentsPerWindow > options.WindowSeconds)
            {
                failures.Add("Platform:RateLimiting:SegmentsPerWindow cannot exceed WindowSeconds.");
            }

            if (options.QueueLimit < 0 || options.QueueLimit > 1000)
            {
                failures.Add("Platform:RateLimiting:QueueLimit must be between 0 and 1000.");
            }

            if (options.RetryAfterSeconds < 1 || options.RetryAfterSeconds > 3600)
            {
                failures.Add("Platform:RateLimiting:RetryAfterSeconds must be between 1 and 3600.");
            }
        }

        private static void ValidateResponseCompression(
            ApiPlatformOptions.ResponseCompressionOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:ResponseCompression configuration is required.");
            }
        }

        private static void ValidateDiagnostics(
            ApiPlatformOptions.DiagnosticsOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:Diagnostics configuration is required.");
            }
        }

        private static void ValidateGovernance(
            ApiPlatformOptions.GovernanceOptions options,
            ICollection<string> failures)
        {
            if (options == null)
            {
                failures.Add("Platform:Governance configuration is required.");
                return;
            }

            if (!options.Enabled)
            {
                return;
            }

            ValidateRange(options.MaxRawTargetChars, 256, 32768, "MaxRawTargetChars", failures);
            ValidateRange(options.MaxPathChars, 128, options.MaxRawTargetChars, "MaxPathChars", failures);
            ValidateRange(options.MaxQueryStringChars, 0, options.MaxRawTargetChars, "MaxQueryStringChars", failures);
            ValidateRange(options.MaxQueryParameters, 1, 1024, "MaxQueryParameters", failures);
            ValidateRange(options.MaxHeaderCount, 8, 256, "MaxHeaderCount", failures);
            ValidateRange(options.MaxHeaderValues, options.MaxHeaderCount, 1024, "MaxHeaderValues", failures);
            ValidateRange(options.MaxHeaderBytes, 4096, 262144, "MaxHeaderBytes", failures);
            ValidateRange(options.MaxAuthorizationHeaderBytes, 256, options.MaxHeaderBytes, "MaxAuthorizationHeaderBytes", failures);
            ValidateRange(options.MaxCookieHeaderBytes, 256, options.MaxHeaderBytes, "MaxCookieHeaderBytes", failures);
            ValidateRange(options.MaxContentTypeHeaderBytes, 64, 4096, "MaxContentTypeHeaderBytes", failures);
            ValidateRange(options.MaxForwardedForHeaderBytes, 64, options.MaxHeaderBytes, "MaxForwardedForHeaderBytes", failures);

            if (options.MaxPathChars + options.MaxQueryStringChars + 1 > options.MaxRawTargetChars)
            {
                failures.Add("Platform:Governance path/query budgets cannot exceed MaxRawTargetChars.");
            }

            if (options.AllowedBodyContentTypes == null || options.AllowedBodyContentTypes.Count == 0)
            {
                failures.Add("Platform:Governance:AllowedBodyContentTypes must contain at least one media type.");
            }
            else
            {
                foreach (var mediaType in options.AllowedBodyContentTypes)
                {
                    if (string.IsNullOrWhiteSpace(mediaType) ||
                        mediaType.Length > 128 ||
                        mediaType.Contains("\r", StringComparison.Ordinal) ||
                        mediaType.Contains("\n", StringComparison.Ordinal) ||
                        !mediaType.Contains("/", StringComparison.Ordinal))
                    {
                        failures.Add($"Invalid request media type '{mediaType ?? "<null>"}'.");
                    }
                }
            }

            var concurrency = options.Concurrency;
            if (concurrency == null)
            {
                failures.Add("Platform:Governance:Concurrency configuration is required.");
                return;
            }

            if (!concurrency.Enabled)
            {
                return;
            }

            ValidateRange(concurrency.MaxConcurrentRequests, 1, 100000, "Concurrency:MaxConcurrentRequests", failures);
            ValidateRange(concurrency.MaxConcurrentPerClient, 1, concurrency.MaxConcurrentRequests, "Concurrency:MaxConcurrentPerClient", failures);
            ValidateRange(concurrency.MaxTrackedClients, 16, 100000, "Concurrency:MaxTrackedClients", failures);
            ValidateRange(concurrency.ClientIdleSeconds, 5, 86400, "Concurrency:ClientIdleSeconds", failures);
            ValidateRange(concurrency.CleanupInterval, 16, 100000, "Concurrency:CleanupInterval", failures);
            ValidateRange(concurrency.RetryAfterSeconds, 1, 3600, "Concurrency:RetryAfterSeconds", failures);
        }

        private static void ValidateRange(
            long value,
            long minimum,
            long maximum,
            string settingName,
            ICollection<string> failures)
        {
            if (value < minimum || value > maximum)
            {
                failures.Add($"Platform:Governance:{settingName} must be between {minimum} and {maximum}.");
            }
        }

        private static bool IsSafeEndpointPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("/", StringComparison.Ordinal))
            {
                return false;
            }

            if (value.Contains("?", StringComparison.Ordinal) ||
                value.Contains("#", StringComparison.Ordinal) ||
                value.Contains("\\", StringComparison.Ordinal) ||
                value.Contains("..", StringComparison.Ordinal))
            {
                return false;
            }

            return Uri.TryCreate("https://localhost" + value, UriKind.Absolute, out _);
        }

        private static bool IsValidHeaderName(string value)
        {
            var trimmed = value.Trim();
            if (trimmed.Length == 0 || trimmed.Length > 64)
            {
                return false;
            }

            foreach (var character in trimmed)
            {
                var valid = char.IsLetterOrDigit(character) || character == '-';
                if (!valid)
                {
                    return false;
                }
            }

            return true;
        }

        private static void ValidateSingleLineHeader(
            string value,
            string settingName,
            ICollection<string> failures,
            bool allowEmpty = false)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                if (!allowEmpty)
                {
                    failures.Add($"Platform:SecurityHeaders:{settingName} is required when security headers are enabled.");
                }
                return;
            }

            if (value.Contains("\r", StringComparison.Ordinal) || value.Contains("\n", StringComparison.Ordinal))
            {
                failures.Add($"Platform:SecurityHeaders:{settingName} must not contain newline characters.");
            }

            if (value.Length > 4096)
            {
                failures.Add($"Platform:SecurityHeaders:{settingName} is unreasonably large.");
            }
        }
    }
}
