using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Api.Core.Platform
{
    public static class ApiPlatformConfigurationResolver
    {
        public static ResolvedDatabaseConfiguration ResolveDatabase(IConfiguration configuration)
        {
            if (configuration == null) throw new ArgumentNullException(nameof(configuration));
            var provider = ApiPlatformDefaults.NormalizeProvider(FirstNonEmpty(configuration["Platform:Database:Provider"], configuration["Database:Provider"]));
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
                    provider = ApiPlatformDefaults.NormalizeProvider(FirstNonEmpty(legacySection["Type"], provider));
                    source = legacySectionName + ":ConnectionString";
                }
            }
            return new ResolvedDatabaseConfiguration(provider, connectionString, source,
                ReadBoundedInt(configuration, "Platform:Database:CommandTimeoutSeconds", 30, 1, 300),
                ReadBoundedInt(configuration, "Platform:Database:RetryCount", 3, 0, 10),
                ReadBoundedInt(configuration, "Platform:Database:RetryMaxDelaySeconds", 5, 1, 60));
        }

        public static IReadOnlyList<string> ResolveAllowedOrigins(IConfiguration configuration)
        {
            if (configuration == null) throw new ArgumentNullException(nameof(configuration));
            return configuration.GetSection("Platform:Cors:AllowedOrigins").GetChildren()
                .Concat(configuration.GetSection("Cors:AllowedOrigins").GetChildren())
                .Select(child => ApiPlatformDefaults.NormalizeOrigin(child.Value))
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        public static bool IsProduction(IConfiguration configuration)
        {
            if (configuration == null) return false;
            var environment = FirstNonEmpty(configuration["ASPNETCORE_ENVIRONMENT"], configuration["DOTNET_ENVIRONMENT"], configuration["Environment"]);
            return string.Equals(environment?.Trim(), "Production", StringComparison.OrdinalIgnoreCase) || string.Equals(environment?.Trim(), "prod", StringComparison.OrdinalIgnoreCase);
        }

        public static ApiPlatformOptions ResolveOptions(IConfiguration configuration)
        {
            if (configuration == null) throw new ArgumentNullException(nameof(configuration));
            var options = new ApiPlatformOptions();
            var platform = configuration.GetSection(ApiPlatformOptions.SectionName);

            // Bind each modern policy independently. RateLimiting.PartitionAuthenticatedUsers is a
            // retired compatibility key; excluding it from generic binding lets the bridge below
            // ignore malformed legacy values instead of letting ConfigurationBinder throw first.
            platform.GetSection("Database").Bind(options.Database);
            platform.GetSection("Cors").Bind(options.Cors);
            platform.GetSection("SecurityHeaders").Bind(options.SecurityHeaders);
            platform.GetSection("Requests").Bind(options.Requests);
            platform.GetSection("Health").Bind(options.Health);
            platform.GetSection("ForwardedHeaders").Bind(options.ForwardedHeaders);
            platform.GetSection("ClientPartitioning").Bind(options.ClientPartitioning);
            platform.GetSection("ResponseCompression").Bind(options.ResponseCompression);
            platform.GetSection("Diagnostics").Bind(options.Diagnostics);
            platform.GetSection("Governance").Bind(options.Governance);
            platform.GetSection("Transport").Bind(options.Transport);

            options.RateLimiting.Enabled = ReadBool(configuration, "Platform:RateLimiting:Enabled", options.RateLimiting.Enabled);
            options.RateLimiting.PermitLimit = ReadInt(configuration, "Platform:RateLimiting:PermitLimit", options.RateLimiting.PermitLimit);
            options.RateLimiting.WindowSeconds = ReadInt(configuration, "Platform:RateLimiting:WindowSeconds", options.RateLimiting.WindowSeconds);
            options.RateLimiting.SegmentsPerWindow = ReadInt(configuration, "Platform:RateLimiting:SegmentsPerWindow", options.RateLimiting.SegmentsPerWindow);
            options.RateLimiting.QueueLimit = ReadInt(configuration, "Platform:RateLimiting:QueueLimit", options.RateLimiting.QueueLimit);
            options.RateLimiting.ExemptOptionsRequests = ReadBool(configuration, "Platform:RateLimiting:ExemptOptionsRequests", options.RateLimiting.ExemptOptionsRequests);
            options.RateLimiting.ExemptHealthChecks = ReadBool(configuration, "Platform:RateLimiting:ExemptHealthChecks", options.RateLimiting.ExemptHealthChecks);
            options.RateLimiting.RetryAfterSeconds = ReadInt(configuration, "Platform:RateLimiting:RetryAfterSeconds", options.RateLimiting.RetryAfterSeconds);

            ApplyClientPartitioningCompatibilityBridge(configuration, options);
            options.Database.Provider = ApiPlatformDefaults.NormalizeProvider(options.Database.Provider);
            options.Cors.AllowedOrigins = ResolveAllowedOrigins(configuration).ToList();
            options.Health.LivenessPath = ApiPlatformDefaults.NormalizePath(options.Health.LivenessPath, "/health/live");
            options.Health.ReadinessPath = ApiPlatformDefaults.NormalizePath(options.Health.ReadinessPath, "/health/ready");
            options.Requests.CorrelationHeaderName = string.IsNullOrWhiteSpace(options.Requests.CorrelationHeaderName) ? ApiPlatformDefaults.CorrelationHeaderName : options.Requests.CorrelationHeaderName.Trim();
            return options;
        }

        private static void ApplyClientPartitioningCompatibilityBridge(IConfiguration configuration, ApiPlatformOptions options)
        {
            if (!string.IsNullOrWhiteSpace(configuration["Platform:ClientPartitioning:PartitionAuthenticatedUsers"])) return;
            if (bool.TryParse(configuration["Platform:RateLimiting:PartitionAuthenticatedUsers"], out var value)) options.ClientPartitioning.PartitionAuthenticatedUsers = value;
        }

        private static int ReadBoundedInt(IConfiguration configuration, string key, int defaultValue, int minimum, int maximum)
            => int.TryParse(configuration[key], out var value) ? Math.Clamp(value, minimum, maximum) : defaultValue;
        private static int ReadInt(IConfiguration configuration, string key, int defaultValue)
            => int.TryParse(configuration[key], out var value) ? value : defaultValue;
        private static bool ReadBool(IConfiguration configuration, string key, bool defaultValue)
            => bool.TryParse(configuration[key], out var value) ? value : defaultValue;
        private static string FirstNonEmpty(params string[] values)
        {
            if (values == null) return null;
            foreach (var value in values) if (!string.IsNullOrWhiteSpace(value)) return value;
            return null;
        }
    }

    public sealed class ResolvedDatabaseConfiguration
    {
        public ResolvedDatabaseConfiguration(string provider, string connectionString, string source, int commandTimeoutSeconds, int retryCount, int retryMaxDelaySeconds)
        { Provider = provider; ConnectionString = connectionString; Source = source; CommandTimeoutSeconds = commandTimeoutSeconds; RetryCount = retryCount; RetryMaxDelaySeconds = retryMaxDelaySeconds; }
        public string Provider { get; }
        public string ConnectionString { get; }
        public string Source { get; }
        public int CommandTimeoutSeconds { get; }
        public int RetryCount { get; }
        public int RetryMaxDelaySeconds { get; }
        public bool IsConfigured => !string.IsNullOrWhiteSpace(ConnectionString);
    }
}
