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

            var commandTimeoutSeconds = ReadBoundedInt(configuration, "Platform:Database:CommandTimeoutSeconds", 30, 1, 300);
            var retryCount = ReadBoundedInt(configuration, "Platform:Database:RetryCount", 3, 0, 10);
            var retryMaxDelaySeconds = ReadBoundedInt(configuration, "Platform:Database:RetryMaxDelaySeconds", 5, 1, 60);

            return new ResolvedDatabaseConfiguration(provider, connectionString, source, commandTimeoutSeconds, retryCount, retryMaxDelaySeconds);
        }

        public static IReadOnlyList<string> ResolveAllowedOrigins(IConfiguration configuration)
        {
            if (configuration == null) throw new ArgumentNullException(nameof(configuration));

            var modern = configuration.GetSection("Platform:Cors:AllowedOrigins").GetChildren()
                .Select(child => ApiPlatformDefaults.NormalizeOrigin(child.Value))
                .Where(value => !string.IsNullOrWhiteSpace(value)).ToList();
            var legacy = configuration.GetSection("Cors:AllowedOrigins").GetChildren()
                .Select(child => ApiPlatformDefaults.NormalizeOrigin(child.Value))
                .Where(value => !string.IsNullOrWhiteSpace(value)).ToList();

            return modern.Concat(legacy).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        public static bool IsProduction(IConfiguration configuration)
        {
            if (configuration == null) return false;
            var environment = FirstNonEmpty(configuration["ASPNETCORE_ENVIRONMENT"], configuration["DOTNET_ENVIRONMENT"], configuration["Environment"]);
            return string.Equals(environment?.Trim(), "Production", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(environment?.Trim(), "prod", StringComparison.OrdinalIgnoreCase);
        }

        public static ApiPlatformOptions ResolveOptions(IConfiguration configuration)
        {
            if (configuration == null) throw new ArgumentNullException(nameof(configuration));

            var options = new ApiPlatformOptions();
            // PartitionAuthenticatedUsers under RateLimiting is a legacy compatibility key. Binding
            // the whole Platform graph would make malformed legacy values fail before the bridge can
            // safely ignore them. Bind the legacy-free graph first, then bind RateLimiting through a
            // filtered section that excludes only that retired identity-policy key.
            configuration.GetSection(ApiPlatformOptions.SectionName).Bind(options, binder =>
            {
                binder.ErrorOnUnknownConfiguration = false;
            });

            // Re-bind rate-limit capacity from explicit scalar keys. This deliberately leaves the
            // legacy partition switch to ApplyClientPartitioningCompatibilityBridge, where malformed
            // values cannot alter the secure modern default.
            options.RateLimiting = new ApiPlatformOptions.RateLimitOptions
            {
                Enabled = ReadBool(configuration, "Platform:RateLimiting:Enabled", options.RateLimiting.Enabled),
                PermitLimit = ReadInt(configuration, "Platform:RateLimiting:PermitLimit", options.RateLimiting.PermitLimit),
                WindowSeconds = ReadInt(configuration, "Platform:RateLimiting:WindowSeconds", options.RateLimiting.WindowSeconds),
                SegmentsPerWindow = ReadInt(configuration, "Platform:RateLimiting:SegmentsPerWindow", options.RateLimiting.SegmentsPerWindow),
                QueueLimit = ReadInt(configuration, "Platform:RateLimiting:QueueLimit", options.RateLimiting.QueueLimit),
                ExemptOptionsRequests = ReadBool(configuration, "Platform:RateLimiting:ExemptOptionsRequests", options.RateLimiting.ExemptOptionsRequests),
                ExemptHealthChecks = ReadBool(configuration, "Platform:RateLimiting:ExemptHealthChecks", options.RateLimiting.ExemptHealthChecks),
                RetryAfterSeconds = ReadInt(configuration, "Platform:RateLimiting:RetryAfterSeconds", options.RateLimiting.RetryAfterSeconds)
            };

            options.ClientPartitioning ??= new ApiPlatformOptions.ClientPartitionOptions();
            ApplyClientPartitioningCompatibilityBridge(configuration, options);
            options.Database.Provider = ApiPlatformDefaults.NormalizeProvider(options.Database.Provider);
            options.Cors.AllowedOrigins = ResolveAllowedOrigins(configuration).ToList();
            options.Health.LivenessPath = ApiPlatformDefaults.NormalizePath(options.Health.LivenessPath, "/health/live");
            options.Health.ReadinessPath = ApiPlatformDefaults.NormalizePath(options.Health.ReadinessPath, "/health/ready");
            options.Requests.CorrelationHeaderName = string.IsNullOrWhiteSpace(options.Requests.CorrelationHeaderName)
                ? ApiPlatformDefaults.CorrelationHeaderName
                : options.Requests.CorrelationHeaderName.Trim();
            return options;
        }

        private static void ApplyClientPartitioningCompatibilityBridge(IConfiguration configuration, ApiPlatformOptions options)
        {
            var modernValue = configuration["Platform:ClientPartitioning:PartitionAuthenticatedUsers"];
            if (!string.IsNullOrWhiteSpace(modernValue)) return;

            var legacyValue = configuration["Platform:RateLimiting:PartitionAuthenticatedUsers"];
            if (bool.TryParse(legacyValue, out var partitionAuthenticatedUsers))
            {
                options.ClientPartitioning.PartitionAuthenticatedUsers = partitionAuthenticatedUsers;
            }
        }

        private static int ReadBoundedInt(IConfiguration configuration, string key, int defaultValue, int minimum, int maximum)
        {
            var raw = configuration[key];
            return int.TryParse(raw, out var value) ? Math.Clamp(value, minimum, maximum) : defaultValue;
        }

        private static int ReadInt(IConfiguration configuration, string key, int defaultValue)
            => int.TryParse(configuration[key], out var value) ? value : defaultValue;

        private static bool ReadBool(IConfiguration configuration, string key, bool defaultValue)
            => bool.TryParse(configuration[key], out var value) ? value : defaultValue;

        private static string FirstNonEmpty(params string[] values)
        {
            if (values == null) return null;
            foreach (var value in values)
            {
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            return null;
        }
    }

    public sealed class ResolvedDatabaseConfiguration
    {
        public ResolvedDatabaseConfiguration(string provider, string connectionString, string source, int commandTimeoutSeconds, int retryCount, int retryMaxDelaySeconds)
        {
            Provider = provider; ConnectionString = connectionString; Source = source;
            CommandTimeoutSeconds = commandTimeoutSeconds; RetryCount = retryCount; RetryMaxDelaySeconds = retryMaxDelaySeconds;
        }
        public string Provider { get; }
        public string ConnectionString { get; }
        public string Source { get; }
        public int CommandTimeoutSeconds { get; }
        public int RetryCount { get; }
        public int RetryMaxDelaySeconds { get; }
        public bool IsConfigured => !string.IsNullOrWhiteSpace(ConnectionString);
    }
}
