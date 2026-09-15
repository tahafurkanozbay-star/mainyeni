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
        }

        public DatabaseOptions Database { get; set; }

        public CorsOptions Cors { get; set; }

        public SecurityHeaderOptions SecurityHeaders { get; set; }

        public RequestOptions Requests { get; set; }

        public HealthOptions Health { get; set; }

        public ForwardedHeaderOptions ForwardedHeaders { get; set; }

        public sealed class DatabaseOptions
        {
            /// <summary>
            /// Only PostgreSQL is enabled by the current deployment architecture.
            /// Other provider migrations must be explicit and tested before enabling.
            /// </summary>
            public string Provider { get; set; } = "PGSQL";

            public int CommandTimeoutSeconds { get; set; } = 30;

            public int RetryCount { get; set; } = 3;

            public int RetryMaxDelaySeconds { get; set; } = 5;
        }

        public sealed class CorsOptions
        {
            public IList<string> AllowedOrigins { get; set; } = new List<string>();

            /// <summary>
            /// Credentials are enabled only for explicitly enumerated origins.
            /// Wildcard origins are never accepted with this option.
            /// </summary>
            public bool AllowCredentials { get; set; } = true;

            public IList<string> AllowedMethods { get; set; } = new List<string>
            {
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "OPTIONS"
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

            /// <summary>
            /// API responses should not normally render HTML. A restrictive CSP is therefore
            /// safe for API/problem responses and Swagger remains opt-in at deployment level.
            /// Empty disables the CSP header when a deployment has a deliberate exception.
            /// </summary>
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

            /// <summary>
            /// Number of trusted proxy hops. The default models a single reverse proxy/load balancer.
            /// </summary>
            public int ForwardLimit { get; set; } = 1;
        }
    }
}
