using Api.Core.Platform.Health;
using Api.Core.Platform.Governance;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System;
using System.Linq;

namespace Api.Core.Platform
{
    /// <summary>
    /// Shared request-pipeline primitives. Startup classes retain product-specific controller and
    /// Swagger wiring while infrastructure ordering is kept consistent here.
    /// </summary>
    public static class ApiPlatformApplicationExtensions
    {
        public static IApplicationBuilder UseKentRehberiPlatformBeforeRouting(
            this IApplicationBuilder app)
        {
            if (app == null)
            {
                throw new ArgumentNullException(nameof(app));
            }

            var options = app.ApplicationServices
                .GetRequiredService<IOptions<ApiPlatformOptions>>()
                .Value;

            if (options.ForwardedHeaders.Enabled)
            {
                app.UseForwardedHeaders(new ForwardedHeadersOptions
                {
                    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
                    ForwardLimit = options.ForwardedHeaders.ForwardLimit
                });
            }

            // Compression wraps the response before the error/security middleware writes a body,
            // allowing large JSON/problem responses to benefit without changing controller code.
            if (options.ResponseCompression.Enabled)
            {
                app.UseResponseCompression();
            }

            // Correlation comes before the exception layer so every subsequent log/problem response
            // can reference the same safe request identifier.
            app.UseMiddleware<CorrelationIdMiddleware>();
            app.UseMiddleware<ApiExceptionMiddleware>();
            // Security headers wrap all downstream early-rejection paths, including governance and
            // payload-budget failures, so malformed requests do not receive a weaker baseline.
            app.UseMiddleware<SecurityHeadersMiddleware>();
            app.UseMiddleware<RequestGovernanceMiddleware>();
            app.UseMiddleware<RequestGuardMiddleware>();

            return app;
        }

        /// <summary>
        /// Must be called after UseRouting because request metrics and rate limiting deliberately use
        /// endpoint metadata. CORS runs before rate limiting so ordinary preflight behavior remains
        /// predictable; exempt OPTIONS requests never consume a limiter partition.
        /// </summary>
        public static IApplicationBuilder UseKentRehberiPlatformAfterRouting(
            this IApplicationBuilder app)
        {
            if (app == null)
            {
                throw new ArgumentNullException(nameof(app));
            }

            var options = app.ApplicationServices
                .GetRequiredService<IOptions<ApiPlatformOptions>>()
                .Value;

            app.UseCors(ApiPlatformDefaults.CorsPolicyName);

            if (options.Diagnostics.Enabled)
            {
                app.UseMiddleware<RequestMetricsMiddleware>();
            }

            if (options.RateLimiting.Enabled)
            {
                app.UseRateLimiter();
            }

            app.UseRequestTimeouts();
            return app;
        }

        public static IEndpointRouteBuilder MapKentRehberiHealthChecks(
            this IEndpointRouteBuilder endpoints)
        {
            if (endpoints == null)
            {
                throw new ArgumentNullException(nameof(endpoints));
            }

            var options = endpoints.ServiceProvider
                .GetRequiredService<IOptions<ApiPlatformOptions>>()
                .Value;

            if (!options.Health.Enabled)
            {
                return endpoints;
            }

            endpoints.MapHealthChecks(
                options.Health.LivenessPath,
                new HealthCheckOptions
                {
                    Predicate = registration => registration.Tags.Contains(ApiPlatformDefaults.LivenessTag),
                    ResponseWriter = HealthResponseWriter.Write
                });

            endpoints.MapHealthChecks(
                options.Health.ReadinessPath,
                new HealthCheckOptions
                {
                    Predicate = registration => registration.Tags.Contains(ApiPlatformDefaults.ReadinessTag),
                    ResponseWriter = HealthResponseWriter.Write
                });

            return endpoints;
        }
    }
}
