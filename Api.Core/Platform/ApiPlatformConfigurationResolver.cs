using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Api.Core.Platform
{
    /// <summary>
    /// Resolves the effective runtime configuration from modern server configuration while
    /// preserving a narrow compatibility bridge for legacy deployment section names.
    /// The bridge is intentionally read-only and never supplies source-controlled secrets.
    /// </summary>
    public static class ApiPlatformConfigurationResolver
    {
        public static ResolvedDatabaseConfiguration ResolveDatabase(IConfiguration configuration)
        {
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }

            var provider = ApiPlatformDefaults.NormalizeProvider(
                FirstNonEmpty(
                    configuration["Platform:Database:Provider"],
                    configuration["Database:Provider"]));

            var connectionString = configuration.GetConnectionString(ApiPlatformDefaults.PrimaryConnectionStringName)?.Trim();
            var source = "ConnectionStrings:Primary";

            if (string.IsNullOrWhiteSpace(connectionString))
            {
                var legacySectionName = IsProduction(configuration) ? "DbConfigProd" : "DbConfigTest";
                var legacySection = configuration.GetSection(legacySectionName);
                var legacyConnectionString = legacySection["ConnectionString"]?.Trim();

                if (!string.IsNullOrWhiteSpace(legacyConnectionString))
                {
                    connectionString = legacyConnectionString;
                    provider = ApiPlatformDefaults.NormalizeProvider(
                        FirstNonEmpty(legacySection["Type"], provider));
                    source = legacySectionName + ":ConnectionString";
                }
            }

            var commandTimeoutSeconds = ReadBoundedInt(
                configuration,
                "Platform:Database:CommandTimeoutSeconds",
                defaultValue: 30,
                minimum: 1,
                maximum: 300);

            var retryCount = ReadBoundedInt(
                configuration,
                "Platform:Database:RetryCount",
                defaultValue: 3,
                minimum: 0,
                maximum: 10);

            var retryMaxDelaySeconds = ReadBoundedInt(
                configuration,
                "Platform:Database:RetryMaxDelaySeconds",
                defaultValue: 5,
                minimum: 1,
                maximum: 60);

            return new ResolvedDatabaseConfiguration(
                provider,
                connectionString,
                source,
                commandTimeoutSeconds,
                retryCount,
                retryMaxDelaySeconds);
        }

        public static IReadOnlyList<string> ResolveAllowedOrigins(IConfiguration configuration)
        {
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }

            var modern = configuration
                .GetSection("Platform:Cors:AllowedOrigins")
                .GetChildren()
                .Select(child => ApiPlatformDefaults.NormalizeOrigin(child.Value))
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToList();

            var legacy = configuration
                .GetSection("Cors:AllowedOrigins")
                .GetChildren()
                .Select(child => ApiPlatformDefaults.NormalizeOrigin(child.Value))
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToList();

            return modern
                .Concat(legacy)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        public static bool IsProduction(IConfiguration configuration)
        {
            if (configuration == null)
            {
                return false;
            }

            var environment = FirstNonEmpty(
                configuration["ASPNETCORE_ENVIRONMENT"],
                configuration["DOTNET_ENVIRONMENT"],
                configuration["Environment"]);

            return string.Equals(environment?.Trim(), "Production", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(environment?.Trim(), "prod", StringComparison.OrdinalIgnoreCase);
        }

        public static ApiPlatformOptions ResolveOptions(IConfiguration configuration)
        {
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }

            var options = new ApiPlatformOptions();
            configuration.GetSection(ApiPlatformOptions.SectionName).Bind(options);

            options.Database.Provider = ApiPlatformDefaults.NormalizeProvider(options.Database.Provider);
            options.Cors.AllowedOrigins = ResolveAllowedOrigins(configuration).ToList();
            options.Health.LivenessPath = ApiPlatformDefaults.NormalizePath(
                options.Health.LivenessPath,
                "/health/live");
            options.Health.ReadinessPath = ApiPlatformDefaults.NormalizePath(
                options.Health.ReadinessPath,
                "/health/ready");

            if (string.IsNullOrWhiteSpace(options.Requests.CorrelationHeaderName))
            {
                options.Requests.CorrelationHeaderName = ApiPlatformDefaults.CorrelationHeaderName;
            }
            else
            {
                options.Requests.CorrelationHeaderName = options.Requests.CorrelationHeaderName.Trim();
            }

            return options;
        }

        private static int ReadBoundedInt(
            IConfiguration configuration,
            string key,
            int defaultValue,
            int minimum,
            int maximum)
        {
            var raw = configuration[key];
            if (!int.TryParse(raw, out var value))
            {
                return defaultValue;
            }

            return Math.Clamp(value, minimum, maximum);
        }

        private static string FirstNonEmpty(params string[] values)
        {
            if (values == null)
            {
                return null;
            }

            foreach (var value in values)
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    return value;
                }
            }

            return null;
        }
    }

    public sealed class ResolvedDatabaseConfiguration
    {
        public ResolvedDatabaseConfiguration(
            string provider,
            string connectionString,
            string source,
            int commandTimeoutSeconds,
            int retryCount,
            int retryMaxDelaySeconds)
        {
            Provider = provider;
            ConnectionString = connectionString;
            Source = source;
            CommandTimeoutSeconds = commandTimeoutSeconds;
            RetryCount = retryCount;
            RetryMaxDelaySeconds = retryMaxDelaySeconds;
        }

        public string Provider { get; }

        public string ConnectionString { get; }

        /// <summary>
        /// Identifies only the configuration key used to resolve the value. Never includes
        /// credentials or the connection string itself, so it is safe for structured diagnostics.
        /// </summary>
        public string Source { get; }

        public int CommandTimeoutSeconds { get; }

        public int RetryCount { get; }

        public int RetryMaxDelaySeconds { get; }

        public bool IsConfigured => !string.IsNullOrWhiteSpace(ConnectionString);
    }
}
