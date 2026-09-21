using System;
using System.Collections.Generic;

namespace Api.Core.Platform
{
    /// <summary>
    /// Strongly typed server-side platform configuration shared by the public and admin APIs.
    /// Values in this model are operational controls, not secrets. Secrets such as database
    /// connection strings and JWT signing keys remain in environment/secret-store configuration.
    /// </summary>
    public sealed class ApiPlatformOptions
    {
        public const string SectionName = "Platform";

        public ApiPlatformOptions()
        {
            Database = new DatabaseOptions();
            Cors = new CorsOptions();
            SecurityHeaders = new SecurityHeaderOptions();
            Requests = new RequestOptions();
            Health = new HealthOptions();
            ForwardedHeaders = new ForwardedHeaderOptions();
            RateLimiting = new RateLimitOptions();
            ResponseCompression = new ResponseCompressionOptions();
            Diagnostics = new DiagnosticsOptions();
            Governance = new GovernanceOptions();
        }

        public DatabaseOptions Database { get; set; }

        public CorsOptions Cors { get; set; }

        public SecurityHeaderOptions SecurityHeaders { get; set; }

        public RequestOptions Requests { get; set; }

        public HealthOptions Health { get; set; }

        public ForwardedHeaderOptions ForwardedHeaders { get; set; }

        public RateLimitOptions RateLimiting { get; set; }

        public ResponseCompressionOptions ResponseCompression { get; set; }

        public DiagnosticsOptions Diagnostics { get; set; }

        public GovernanceOptions Governance { get; set; }

        public sealed class DatabaseOptions
        {
            public string Provider { get; set; } = "PGSQL";
            public int CommandTimeoutSeconds { get; set; } = 30;
            public int RetryCount { get; set; } = 3;
            public int RetryMaxDelaySeconds { get; set; } = 5;
        }

        public sealed class CorsOptions
        {
            public IList<string> AllowedOrigins { get; set; } = new List<string>();
            public bool AllowCredentials { get; set; } = true;
            public IList<string> AllowedMethods { get; set; } = new List<string>
            {
                "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"
            };
            public IList<string> AllowedHeaders { get; set; } = new List<string>
            {
                "Authorization",
                "Accept",
                "Content-Type",
                "Culture",
                "Origin",
                "User-Agent",
                ApiPlatformDefaults.CorrelationHeaderName
            };
        }

        public sealed class SecurityHeaderOptions
        {
            public bool Enabled { get; set; } = true;
            public bool EnableHsts { get; set; } = true;
            public int HstsMaxAgeSeconds { get; set; } = 31536000;
            public bool HstsIncludeSubDomains { get; set; } = true;
            public string FrameOptions { get; set; } = "DENY";
            public string ReferrerPolicy { get; set; } = "no-referrer";
            public string PermissionsPolicy { get; set; } =
                "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
            public string CrossOriginResourcePolicy { get; set; } = "same-origin";
            public string CrossOriginOpenerPolicy { get; set; } = "same-origin";
            public string CrossOriginEmbedderPolicy { get; set; } = string.Empty;
            public string ContentSecurityPolicy { get; set; } =
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
        }

        public sealed class RequestOptions
        {
            public int TimeoutSeconds { get; set; } = 30;
            public long MaxRequestBodyBytes { get; set; } = 10 * 1024 * 1024;
            public int MaxCorrelationIdLength { get; set; } = 96;
            public string CorrelationHeaderName { get; set; } = ApiPlatformDefaults.CorrelationHeaderName;
            public bool RejectTraceHeaderWithInvalidCharacters { get; set; } = true;
        }

        public sealed class HealthOptions
        {
            public bool Enabled { get; set; } = true;
            public string LivenessPath { get; set; } = "/health/live";
            public string ReadinessPath { get; set; } = "/health/ready";
            public int DatabaseTimeoutSeconds { get; set; } = 3;
        }

        public sealed class ForwardedHeaderOptions
        {
            public bool Enabled { get; set; } = true;
            public int ForwardLimit { get; set; } = 1;
        }

        /// <summary>
        /// Global abuse-resistance controls. The limiter partitions authenticated users by a
        /// one-way hash of their subject identifier and anonymous callers by the normalized remote
        /// address established after forwarded-header processing. Arbitrary client headers are not
        /// accepted as an authorization or trust boundary.
        /// </summary>
        public sealed class RateLimitOptions
        {
            public bool Enabled { get; set; } = true;
            public int PermitLimit { get; set; } = 240;
            public int WindowSeconds { get; set; } = 60;
            public int SegmentsPerWindow { get; set; } = 6;
            public int QueueLimit { get; set; } = 0;
            public bool ExemptOptionsRequests { get; set; } = true;
            public bool ExemptHealthChecks { get; set; } = true;
            public bool PartitionAuthenticatedUsers { get; set; } = true;
            public int RetryAfterSeconds { get; set; } = 1;
        }

        public sealed class ResponseCompressionOptions
        {
            public bool Enabled { get; set; } = true;

            /// <summary>
            /// Kent Rehberi APIs return JSON/problem payloads over HTTPS and do not reflect secrets
            /// alongside attacker-controlled HTML, so HTTPS compression is enabled by default.
            /// </summary>
            public bool EnableForHttps { get; set; } = true;
        }

        public sealed class GovernanceOptions
        {
            /// <summary>
            /// Enables the metadata preflight and concurrency bulkhead. This boundary runs before
            /// controllers and model binding so malformed/oversized request metadata is rejected
            /// before expensive application allocations occur.
            /// </summary>
            public bool Enabled { get; set; } = true;

            public int MaxRawTargetChars { get; set; } = 8192;

            public int MaxPathChars { get; set; } = 2048;

            public int MaxQueryStringChars { get; set; } = 6144;

            public int MaxQueryParameters { get; set; } = 128;

            public int MaxHeaderCount { get; set; } = 64;

            public int MaxHeaderValues { get; set; } = 128;

            public long MaxHeaderBytes { get; set; } = 32768;

            public long MaxAuthorizationHeaderBytes { get; set; } = 8192;

            public long MaxCookieHeaderBytes { get; set; } = 16384;

            public long MaxContentTypeHeaderBytes { get; set; } = 512;

            public long MaxForwardedForHeaderBytes { get; set; } = 4096;

            public bool RejectTraceAndConnect { get; set; } = true;

            public bool RejectBackslashInPath { get; set; } = true;

            public bool RejectPathTraversal { get; set; } = true;

            public bool RejectEncodedPathSeparators { get; set; } = true;

            public bool RejectHeaderNewlines { get; set; } = true;

            public bool RequireKnownContentTypeForBodyRequests { get; set; } = true;

            public IList<string> AllowedBodyContentTypes { get; set; } = new List<string>
            {
                "application/json",
                "application/*+json",
                "application/geo+json",
                "application/problem+json",
                "application/x-www-form-urlencoded",
                "multipart/form-data"
            };

            public ConcurrencyOptions Concurrency { get; set; } = new ConcurrencyOptions();
        }

        public sealed class ConcurrencyOptions
        {
            public bool Enabled { get; set; } = true;

            public int MaxConcurrentRequests { get; set; } = 512;

            public int MaxConcurrentPerClient { get; set; } = 32;

            public int MaxTrackedClients { get; set; } = 4096;

            public int ClientIdleSeconds { get; set; } = 120;

            public int CleanupInterval { get; set; } = 128;

            public bool ExemptOptionsRequests { get; set; } = true;

            public bool ExemptHealthChecks { get; set; } = true;

            public int RetryAfterSeconds { get; set; } = 1;
        }

        public sealed class DiagnosticsOptions
        {
            /// <summary>
            /// Enables in-process System.Diagnostics.Metrics instruments. No telemetry leaves the
            /// process unless the hosting environment explicitly attaches a listener/exporter.
            /// </summary>
            public bool Enabled { get; set; } = true;

            /// <summary>
            /// Adds only aggregate application duration to Server-Timing. Database statements,
            /// internal hosts, identities and request parameters are never written to this header.
            /// </summary>
            public bool ServerTimingHeader { get; set; } = true;
        }
    }
}
