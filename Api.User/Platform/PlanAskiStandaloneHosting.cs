using Api.Core.Platform;
using Api.User.Filters;
using Api.User.KentRehberi;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.RateLimiting;

namespace Api.User.Platform;

/// <summary>
/// Opt-in, read-only PlanASKI map API. Never registers the general application
/// database or the administrative/GIS configuration controllers.
/// </summary>
public static class PlanAskiStandaloneHosting
{
    public const string EnabledKey = "KentRehberiData:Standalone";

    /// <summary>
    /// Start the isolated host only when expressly requested. Kept separate
    /// from Program.cs so the normal startup security pipeline is unchanged.
    /// </summary>
    public static bool TryRun(WebApplicationBuilder builder)
    {
        if (!IsEnabled(builder.Configuration))
        {
            return false;
        }

        AddServices(builder.Services, builder.Configuration);
        var app = builder.Build();
        Map(app);
        app.Run();
        return true;
    }

    public static bool IsEnabled(IConfiguration configuration) =>
        configuration.GetValue<bool>(EnabledKey);

    public static void AddServices(
        IServiceCollection services,
        IConfiguration configuration)
    {
        if (!IsEnabled(configuration))
        {
            throw new InvalidOperationException(
                "Standalone PlanASKI hosting must be explicitly enabled.");
        }

        var options = new KentRehberiOptions();
        configuration.GetSection(KentRehberiOptions.SectionName).Bind(options);

        // Standalone must never silently switch to a database-backed source or
        // expose a data-disabled API with an apparently healthy probe.
        if (!options.Enabled ||
            !string.Equals(
                options.Source,
                KentRehberiOptions.PlanAskiSource,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "Standalone Kent Rehberi requires Enabled=true and Source=PlanAski.");
        }

        // Reuse the validated, host-pinned HTTPS upstream, bounded caches,
        // result-integrity checks, and the existing GeoJSON controllers.
        services.AddKentRehberiData(configuration);
        services.AddScoped<AppRequestFilterAttribute>();

        services.AddControllers()
            .ConfigureApplicationPartManager(manager =>
            {
                // Fail closed: no AppSettings, authentication, admin or GIS proxy
                // controllers may be discovered in this opt-in mode.
                manager.FeatureProviders.Clear();
                manager.FeatureProviders.Add(
                    new PlanAskiPublicControllerFeatureProvider());
            });

        services.AddAuthorization();
        services.AddRateLimiter(limiter =>
        {
            limiter.RejectionStatusCode =
                StatusCodes.Status429TooManyRequests;
            // Deliberately use the socket IP rather than untrusted X-Forwarded-For.
            // A trusted reverse proxy should enforce its own client-aware limits.
            limiter.GlobalLimiter =
                PartitionedRateLimiter.Create<HttpContext, string>(
                    context => RateLimitPartition.GetFixedWindowLimiter(
                        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                        _ => new FixedWindowRateLimiterOptions
                        {
                            PermitLimit = 240,
                            Window = TimeSpan.FromMinutes(1),
                            QueueLimit = 0,
                            AutoReplenishment = true
                        }));
        });
    }

    public static void Map(WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["X-Frame-Options"] = "DENY";
            await next(context);
        });

        app.UseRouting();
        app.UseRateLimiter();
        app.UseAuthorization();
        app.MapControllers();

        app.MapGet("/health/live", () => Results.Ok(new { status = "healthy" }));
        app.MapHealthChecks(
            "/health/ready",
            new HealthCheckOptions
            {
                Predicate = registration =>
                    registration.Tags.Contains(ApiPlatformDefaults.ReadinessTag)
            });
    }
}

/// <summary>
/// Positive allowlist instead of assembly scanning: only the five public
/// Kent Rehberi data operations become routable.
/// </summary>
public sealed class PlanAskiPublicControllerFeatureProvider :
    IApplicationFeatureProvider<ControllerFeature>
{
    public void PopulateFeature(
        IEnumerable<ApplicationPart> parts,
        ControllerFeature feature)
    {
        feature.Controllers.Add(typeof(KentRehberiController).GetTypeInfo());
    }
}
