using Api.Core.Platform.Health;
using Api.Core.Platform.Governance;
using Api.Core.Platform.Lifecycle;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System;
using System.Linq;

namespace Api.Core.Platform
{
    public static class ApiPlatformApplicationExtensions
    {
        public static IApplicationBuilder UseKentRehberiPlatformBeforeRouting(this IApplicationBuilder app)
        {
            if (app == null) throw new ArgumentNullException(nameof(app));
            var options = app.ApplicationServices.GetRequiredService<IOptions<ApiPlatformOptions>>().Value;
            if (options.ForwardedHeaders.Enabled)
            {
                var configuration = app.ApplicationServices.GetRequiredService<IConfiguration>();
                app.UseForwardedHeaders(ForwardedHeaderTrustPolicy.Build(options.ForwardedHeaders, configuration));
            }
            if (options.ResponseCompression.Enabled) app.UseResponseCompression();
            app.UseMiddleware<CorrelationIdMiddleware>();
            app.UseMiddleware<ApiExceptionMiddleware>();
            app.UseMiddleware<SecurityHeadersMiddleware>();
            app.UseMiddleware<RequestGovernanceMiddleware>();
            app.UseMiddleware<RequestGuardMiddleware>();
            if (options.Lifecycle.Enabled) app.UseMiddleware<RequestLifecycleMiddleware>();
            return app;
        }

        public static IApplicationBuilder UseKentRehberiPlatformAfterRouting(this IApplicationBuilder app)
        {
            if (app == null) throw new ArgumentNullException(nameof(app));
            var options = app.ApplicationServices.GetRequiredService<IOptions<ApiPlatformOptions>>().Value;
            app.UseCors(ApiPlatformDefaults.CorsPolicyName);
            if (options.Diagnostics.Enabled) app.UseMiddleware<RequestMetricsMiddleware>();
            if (options.RateLimiting.Enabled) app.UseRateLimiter();
            app.UseRequestTimeouts();
            return app;
        }

        public static IEndpointRouteBuilder MapKentRehberiHealthChecks(this IEndpointRouteBuilder endpoints)
        {
            if (endpoints == null) throw new ArgumentNullException(nameof(endpoints));
            var options = endpoints.ServiceProvider.GetRequiredService<IOptions<ApiPlatformOptions>>().Value;
            if (!options.Health.Enabled) return endpoints;
            endpoints.MapHealthChecks(options.Health.LivenessPath, new HealthCheckOptions { Predicate = r => r.Tags.Contains(ApiPlatformDefaults.LivenessTag), ResponseWriter = HealthResponseWriter.Write });
            endpoints.MapHealthChecks(options.Health.ReadinessPath, new HealthCheckOptions { Predicate = r => r.Tags.Contains(ApiPlatformDefaults.ReadinessTag), ResponseWriter = HealthResponseWriter.Write });
            return endpoints;
        }
    }
}
