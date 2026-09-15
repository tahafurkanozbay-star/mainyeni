using Api.Core.Platform.Health;
using Business.Core.Context;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Timeouts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace Api.Core.Platform
{
    /// <summary>
    /// Shared registration boundary for Kent Rehberi API infrastructure. Keeping infrastructure
    /// registration here prevents User/Admin API startup behavior from drifting over time.
    /// </summary>
    public static class ApiPlatformServiceCollectionExtensions
    {
        public static IServiceCollection AddKentRehberiApiPlatform(
            this IServiceCollection services,
            IConfiguration configuration)
        {
            if (services == null)
            {
                throw new ArgumentNullException(nameof(services));
            }
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }

            var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);
            ValidateOptions(options);
            var database = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);
            ValidateDatabase(database);

            services.AddSingleton<IOptions<ApiPlatformOptions>>(Options.Create(options));
            services.AddSingleton(options);

            AddDatabase(services, database);
            AddCors(services, options);
            AddRequestTimeoutPolicy(services, options);
            AddHealthChecks(services, options);

            services.AddHttpContextAccessor();
            return services;
        }

        private static void ValidateOptions(ApiPlatformOptions options)
        {
            var validator = new ApiPlatformOptionsValidator();
            var result = validator.Validate(Options.DefaultName, options);
            if (result.Succeeded)
            {
                return;
            }

            throw new OptionsValidationException(
                Options.DefaultName,
                typeof(ApiPlatformOptions),
                result.Failures);
        }

        private static void ValidateDatabase(ResolvedDatabaseConfiguration database)
        {
            if (!database.IsConfigured)
            {
                throw new InvalidOperationException(
                    "Database connection string is not configured. " +
                    "Set ConnectionStrings__Primary in the server secret store/environment.");
            }

            if (!string.Equals(
                    database.Provider,
                    ApiPlatformDefaults.PostgreSqlProvider,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Unsupported database provider '{database.Provider}'. " +
                    "The active runtime is hardened for PostgreSQL; migrate other providers explicitly before enabling them.");
            }
        }

        private static void AddDatabase(
            IServiceCollection services,
            ResolvedDatabaseConfiguration database)
        {
            services.AddDbContextPool<BusinessContext>(options =>
            {
                options.UseNpgsql(database.ConnectionString, npgsql =>
                {
                    npgsql.CommandTimeout(database.CommandTimeoutSeconds);
                    if (database.RetryCount > 0)
                    {
                        npgsql.EnableRetryOnFailure(
                            maxRetryCount: database.RetryCount,
                            maxRetryDelay: TimeSpan.FromSeconds(database.RetryMaxDelaySeconds),
                            errorCodesToAdd: null);
                    }
                });
            });
        }

        private static void AddCors(
            IServiceCollection services,
            ApiPlatformOptions options)
        {
            var cors = options.Cors;
            var origins = cors.AllowedOrigins
                .Select(ApiPlatformDefaults.NormalizeOrigin)
                .Where(origin => !string.IsNullOrWhiteSpace(origin))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            var methods = cors.AllowedMethods
                .Where(method => !string.IsNullOrWhiteSpace(method))
                .Select(method => method.Trim().ToUpperInvariant())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            var headers = cors.AllowedHeaders
                .Where(header => !string.IsNullOrWhiteSpace(header))
                .Select(header => header.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            services.AddCors(corsOptions =>
            {
                corsOptions.AddPolicy(ApiPlatformDefaults.CorsPolicyName, policy =>
                {
                    policy.WithMethods(methods).WithHeaders(headers);

                    if (origins.Length > 0)
                    {
                        policy.WithOrigins(origins);
                        if (cors.AllowCredentials)
                        {
                            policy.AllowCredentials();
                        }
                    }
                });
            });
        }

        private static void AddRequestTimeoutPolicy(
            IServiceCollection services,
            ApiPlatformOptions options)
        {
            services.AddRequestTimeouts(timeoutOptions =>
            {
                timeoutOptions.DefaultPolicy = new RequestTimeoutPolicy
                {
                    Timeout = TimeSpan.FromSeconds(options.Requests.TimeoutSeconds),
                    TimeoutStatusCode = StatusCodes.Status504GatewayTimeout,
                    WriteTimeoutResponse = WriteTimeoutResponse
                };
            });
        }

        private static Task WriteTimeoutResponse(HttpContext context)
        {
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers.CacheControl = "no-store";

            var payload = new
            {
                type = "about:blank",
                title = "Request timed out",
                status = StatusCodes.Status504GatewayTimeout,
                traceId = context.TraceIdentifier,
                correlationId = context.Items.TryGetValue(ApiPlatformDefaults.TraceIdItemKey, out var id)
                    ? id?.ToString()
                    : null
            };

            return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
        }

        private static void AddHealthChecks(
            IServiceCollection services,
            ApiPlatformOptions options)
        {
            if (!options.Health.Enabled)
            {
                return;
            }

            services.AddHealthChecks()
                .AddCheck(
                    "self",
                    () => HealthCheckResult.Healthy("Application process is running."),
                    tags: new[] { ApiPlatformDefaults.LivenessTag })
                .AddCheck<DatabaseHealthCheck>(
                    ApiPlatformDefaults.DatabaseHealthCheckName,
                    failureStatus: HealthStatus.Unhealthy,
                    tags: new[] { ApiPlatformDefaults.ReadinessTag });
        }
    }
}
