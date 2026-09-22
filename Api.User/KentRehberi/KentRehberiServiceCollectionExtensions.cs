using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Linq;
using System.Net;
using System.Net.Http;

namespace Api.User.KentRehberi;

public static class KentRehberiServiceCollectionExtensions
{
    public static IServiceCollection AddKentRehberiData(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var options = new KentRehberiOptions();
        configuration.GetSection(KentRehberiOptions.SectionName).Bind(options);

        var failures = options.Validate();
        if (failures.Count > 0)
        {
            throw new InvalidOperationException(
                "Invalid KentRehberiData configuration: " +
                string.Join(" ", failures.Distinct(StringComparer.Ordinal)));
        }

        services.AddSingleton(options);
        services.AddSingleton(TimeProvider.System);

        services.AddHttpClient(
                KentRehberiPlanAskiSource.HttpClientName,
                client =>
                {
                    client.Timeout = Timeout.InfiniteTimeSpan;
                    client.DefaultRequestHeaders.UserAgent.ParseAdd(
                        "Ankara-Kent-Rehberi-User-API/1.0");
                })
            .ConfigurePrimaryHttpMessageHandler(
                static () =>
                    new HttpClientHandler
                    {
                        AllowAutoRedirect = false,
                        AutomaticDecompression =
                            DecompressionMethods.GZip |
                            DecompressionMethods.Deflate |
                            DecompressionMethods.Brotli,
                        UseCookies = false
                    });
        services.AddSingleton<KentRehberiTelemetry>();
        services.AddSingleton<KentRehberiAdmissionController>();
        services.AddSingleton<KentRehberiBoundedResultCache>();
        services.AddSingleton<KentRehberiSingleFlight<KentRehberiFeatureCollection>>();
        services.AddSingleton<KentRehberiSingleFlight<KentRehberiFeature?>>();
        services.AddSingleton<KentRehberiSingleFlight<KentRehberiTypeCatalog>>();
        services.AddSingleton<KentRehberiResultIntegrityGuard>();
        services.AddSingleton<KentRehberiTypeCatalogIntegrityGuard>();
        services.AddSingleton<KentRehberiTypeCatalogCache>();
        services.AddSingleton<KentRehberiConnectionFactory>();
        services.AddSingleton<KentRehberiPlanAskiSource>();
        services.AddScoped<KentRehberiRepository>();
        services.AddScoped<KentRehberiPlanAskiRepository>();
        services.AddScoped<IKentRehberiRepository>(
            provider =>
            {
                var configured =
                    provider.GetRequiredService<KentRehberiOptions>();

                if (string.Equals(
                        configured.Source,
                        KentRehberiOptions.PlanAskiSource,
                        StringComparison.OrdinalIgnoreCase))
                {
                    return provider.GetRequiredService<
                        KentRehberiPlanAskiRepository>();
                }

                return provider.GetRequiredService<
                    KentRehberiRepository>();
            });
        services.AddScoped<IKentRehberiQueryService, KentRehberiQueryService>();
        services.AddScoped<IKentRehberiTypeCatalogService, KentRehberiTypeCatalogService>();

        services.AddHealthChecks()
            .AddCheck<KentRehberiHealthCheck>(
                "kent-rehberi-data",
                failureStatus: HealthStatus.Unhealthy,
                tags: new[] { ApiPlatformDefaults.ReadinessTag });

        return services;
    }
}
