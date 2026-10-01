using Api.Core.Platform.Diagnostics;
using Api.Core.Platform.Health;
using Api.Core.Platform.Governance;
using Api.Core.Platform.Lifecycle;
using Api.Core.Platform.Middleware;
using Api.Core.Platform.RateLimiting;
using Business.Core.Context;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Timeouts;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using System.Threading.RateLimiting;
using System.Threading.Tasks;

namespace Api.Core.Platform
{
    public static class ApiPlatformServiceCollectionExtensions
    {
        private static readonly string[] AdditionalCompressibleMimeTypes = { "application/problem+json", "application/geo+json" };

        public static IServiceCollection AddKentRehberiApiPlatform(this IServiceCollection services, IConfiguration configuration)
        {
            if (services == null) throw new ArgumentNullException(nameof(services));
            if (configuration == null) throw new ArgumentNullException(nameof(configuration));
            var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);
            ValidateOptions(options);
            var database = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);
            ValidateDatabase(database);
            services.AddSingleton<IOptions<ApiPlatformOptions>>(Options.Create(options));
            services.AddSingleton(options);
            AddDatabase(services, database); AddCors(services, options); AddRequestTimeoutPolicy(services, options);
            AddHealthChecks(services, options); AddResponseCompression(services, options); AddRateLimiting(services, options); AddDiagnostics(services, options);
            services.AddSingleton<RequestConcurrencyGovernor>();
            services.AddSingleton<RequestLifecyclePolicy>();
            services.AddSingleton<RequestLifecycleCoordinator>();
            services.AddHttpContextAccessor();
            return services;
        }

        private static void ValidateOptions(ApiPlatformOptions options)
        {
            var result = new ApiPlatformOptionsValidator().Validate(Options.DefaultName, options);
            if (!result.Succeeded) throw new OptionsValidationException(Options.DefaultName, typeof(ApiPlatformOptions), result.Failures);
            var lifecycle = options.Lifecycle;
            if (lifecycle == null) throw new OptionsValidationException(Options.DefaultName, typeof(ApiPlatformOptions), new[] { "Platform:Lifecycle configuration is required." });
            ValidateLifecycleRange(lifecycle.ReadTimeoutSeconds, 1, 300, "ReadTimeoutSeconds");
            ValidateLifecycleRange(lifecycle.MutationTimeoutSeconds, 1, 300, "MutationTimeoutSeconds");
            ValidateLifecycleRange(lifecycle.BulkTimeoutSeconds, 1, 900, "BulkTimeoutSeconds");
            ValidateLifecycleRange(lifecycle.HealthTimeoutSeconds, 1, 30, "HealthTimeoutSeconds");
            ValidateLifecycleRange(lifecycle.ShutdownDrainSeconds, 1, 120, "ShutdownDrainSeconds");
            if (lifecycle.HealthTimeoutSeconds > lifecycle.ReadTimeoutSeconds)
                throw new OptionsValidationException(Options.DefaultName, typeof(ApiPlatformOptions), new[] { "Platform:Lifecycle:HealthTimeoutSeconds cannot exceed ReadTimeoutSeconds." });
        }

        private static void ValidateLifecycleRange(int value, int min, int max, string name)
        {
            if (value < min || value > max) throw new OptionsValidationException(Options.DefaultName, typeof(ApiPlatformOptions), new[] { $"Platform:Lifecycle:{name} must be between {min} and {max}." });
        }

        private static void ValidateDatabase(ResolvedDatabaseConfiguration database)
        {
            if (!database.IsConfigured) throw new InvalidOperationException("Database connection string is not configured. Set ConnectionStrings__Primary in the server secret store/environment.");
            if (!string.Equals(database.Provider, ApiPlatformDefaults.PostgreSqlProvider, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Unsupported database provider '{database.Provider}'. The active runtime is hardened for PostgreSQL; migrate other providers explicitly before enabling them.");
        }

        private static void AddDatabase(IServiceCollection services, ResolvedDatabaseConfiguration database)
        {
            services.AddDbContextPool<BusinessContext>(options => options.UseNpgsql(database.ConnectionString, npgsql =>
            {
                npgsql.CommandTimeout(database.CommandTimeoutSeconds);
                if (database.RetryCount > 0) npgsql.EnableRetryOnFailure(database.RetryCount, TimeSpan.FromSeconds(database.RetryMaxDelaySeconds), null);
            }));
        }

        private static void AddCors(IServiceCollection services, ApiPlatformOptions options)
        {
            var cors = options.Cors;
            var origins = cors.AllowedOrigins.Select(ApiPlatformDefaults.NormalizeOrigin).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var methods = cors.AllowedMethods.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim().ToUpperInvariant()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var headers = cors.AllowedHeaders.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            services.AddCors(o => o.AddPolicy(ApiPlatformDefaults.CorsPolicyName, p => { p.WithMethods(methods).WithHeaders(headers); if (origins.Length > 0) { p.WithOrigins(origins); if (cors.AllowCredentials) p.AllowCredentials(); } }));
        }

        private static void AddRequestTimeoutPolicy(IServiceCollection services, ApiPlatformOptions options)
        {
            services.AddRequestTimeouts(o => o.DefaultPolicy = new RequestTimeoutPolicy { Timeout = TimeSpan.FromSeconds(options.Requests.TimeoutSeconds), TimeoutStatusCode = StatusCodes.Status504GatewayTimeout, WriteTimeoutResponse = WriteTimeoutResponse });
        }

        private static Task WriteTimeoutResponse(HttpContext context)
        {
            context.Response.ContentType = "application/problem+json"; context.Response.Headers.CacheControl = "no-store";
            return context.Response.WriteAsync(JsonSerializer.Serialize(new { type = "about:blank", title = "Request timed out", status = 504, traceId = context.TraceIdentifier }));
        }

        private static void AddHealthChecks(IServiceCollection services, ApiPlatformOptions options)
        {
            if (!options.Health.Enabled) return;
            services.AddHealthChecks().AddCheck("self", () => HealthCheckResult.Healthy("Application process is running."), tags: new[] { ApiPlatformDefaults.LivenessTag })
                .AddCheck<DatabaseHealthCheck>(ApiPlatformDefaults.DatabaseHealthCheckName, failureStatus: HealthStatus.Unhealthy, tags: new[] { ApiPlatformDefaults.ReadinessTag });
        }

        private static void AddResponseCompression(IServiceCollection services, ApiPlatformOptions options)
        {
            if (!options.ResponseCompression.Enabled) return;
            services.AddResponseCompression(o => { o.EnableForHttps = options.ResponseCompression.EnableForHttps; o.Providers.Add<BrotliCompressionProvider>(); o.Providers.Add<GzipCompressionProvider>(); o.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(AdditionalCompressibleMimeTypes).Distinct(StringComparer.OrdinalIgnoreCase); });
            services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest); services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
        }

        private static void AddRateLimiting(IServiceCollection services, ApiPlatformOptions options)
        {
            if (!options.RateLimiting.Enabled) return;
            var limiter = options.RateLimiting;
            services.AddRateLimiter(o =>
            {
                o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
                o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context => ClientRateLimitPartitioner.ShouldBypass(context, options)
                    ? RateLimitPartition.GetNoLimiter(ClientRateLimitPartitioner.ResolveBypassPartition(context, options))
                    : RateLimitPartition.GetSlidingWindowLimiter(ClientRateLimitPartitioner.ResolvePartitionKey(context, options), _ => new SlidingWindowRateLimiterOptions { PermitLimit = limiter.PermitLimit, Window = TimeSpan.FromSeconds(limiter.WindowSeconds), SegmentsPerWindow = limiter.SegmentsPerWindow, QueueProcessingOrder = QueueProcessingOrder.OldestFirst, QueueLimit = limiter.QueueLimit, AutoReplenishment = true }));
                o.OnRejected = (context, token) => ApiRateLimitResponseWriter.WriteAsync(context, token, limiter.RetryAfterSeconds);
            });
        }

        private static void AddDiagnostics(IServiceCollection services, ApiPlatformOptions options) { if (options.Diagnostics.Enabled) services.AddSingleton<ApiRuntimeMetrics>(); }
    }
}
