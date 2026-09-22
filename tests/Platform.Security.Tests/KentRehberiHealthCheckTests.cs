using Api.Core.Platform;
using Api.User.KentRehberi;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging.Abstractions;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiHealthCheckTests
{
    [Fact]
    public async Task DisabledDataSource_IsHealthyWithoutNetworkOrDatabase()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.Enabled = false);
        var configuration =
            BuildConfiguration(
                new Dictionary<string, string?>());
        var connectionFactory =
            new KentRehberiConnectionFactory(
                configuration,
                options);

        using var httpFactory =
            new StubHttpClientFactory(
                new DelegatingStubHttpMessageHandler(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]"))));
        using var source =
            new KentRehberiPlanAskiSource(
                httpFactory,
                options,
                new ManualKentRehberiTimeProvider(
                    System.DateTimeOffset.UtcNow),
                NullLogger<
                    KentRehberiPlanAskiSource>
                    .Instance);
        var healthCheck =
            new KentRehberiHealthCheck(
                connectionFactory,
                source,
                options);

        var result =
            await healthCheck.CheckHealthAsync(
                new HealthCheckContext());

        Assert.Equal(
            HealthStatus.Healthy,
            result.Status);
        Assert.Contains(
            "disabled",
            result.Description ??
                string.Empty,
            System.StringComparison
                .OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PlanAskiSource_HealthyWhenOfficialUpstreamResponds()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]")));
        var configuration =
            BuildConfiguration(
                new Dictionary<string, string?>());
        var connectionFactory =
            new KentRehberiConnectionFactory(
                configuration,
                fixture.Options);
        var healthCheck =
            new KentRehberiHealthCheck(
                connectionFactory,
                fixture.Source,
                fixture.Options);

        var result =
            await healthCheck.CheckHealthAsync(
                new HealthCheckContext());

        Assert.Equal(
            HealthStatus.Healthy,
            result.Status);
        Assert.Contains(
            "reachable",
            result.Description ??
                string.Empty,
            System.StringComparison
                .OrdinalIgnoreCase);
        Assert.True(
            result.Data.TryGetValue(
                "durationMs",
                out _));
    }

    [Fact]
    public async Task PlanAskiSource_UpstreamFailureIsUnhealthy()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            new System.Net.Http
                                .HttpResponseMessage(
                                    HttpStatusCode
                                        .ServiceUnavailable)));
        var configuration =
            BuildConfiguration(
                new Dictionary<string, string?>());
        var connectionFactory =
            new KentRehberiConnectionFactory(
                configuration,
                fixture.Options);
        var healthCheck =
            new KentRehberiHealthCheck(
                connectionFactory,
                fixture.Source,
                fixture.Options);

        var result =
            await healthCheck.CheckHealthAsync(
                new HealthCheckContext());

        Assert.Equal(
            HealthStatus.Unhealthy,
            result.Status);
        Assert.Contains(
            "failed",
            result.Description ??
                string.Empty,
            System.StringComparison
                .OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "planaski.ankara.bel.tr",
            result.Description ??
                string.Empty,
            System.StringComparison
                .OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PostgisSource_WithoutServerSecret_IsUnhealthy()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.Source =
                        KentRehberiOptions
                            .PostgisSource);
        var configuration =
            BuildConfiguration(
                new Dictionary<string, string?>());
        var connectionFactory =
            new KentRehberiConnectionFactory(
                configuration,
                options);

        using var httpFactory =
            new StubHttpClientFactory(
                new DelegatingStubHttpMessageHandler(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]"))));
        using var source =
            new KentRehberiPlanAskiSource(
                httpFactory,
                options,
                new ManualKentRehberiTimeProvider(
                    System.DateTimeOffset.UtcNow),
                NullLogger<
                    KentRehberiPlanAskiSource>
                    .Instance);
        var healthCheck =
            new KentRehberiHealthCheck(
                connectionFactory,
                source,
                options);

        var result =
            await healthCheck.CheckHealthAsync(
                new HealthCheckContext());

        Assert.Equal(
            HealthStatus.Unhealthy,
            result.Status);
        Assert.Contains(
            "not configured",
            result.Description ??
                string.Empty,
            System.StringComparison
                .OrdinalIgnoreCase);
    }

    [Fact]
    public void ServiceRegistration_AddsDedicatedReadinessProbe()
    {
        var services =
            new ServiceCollection();
        var configuration =
            BuildConfiguration(
                new Dictionary<string, string?>
                {
                    ["KentRehberiData:Enabled"] =
                        "true"
                });

        services.AddLogging();
        services.AddKentRehberiData(
            configuration);

        using var provider =
            services.BuildServiceProvider();
        var healthOptions =
            provider
                .GetRequiredService<
                    IOptions<
                        HealthCheckServiceOptions>>()
                .Value;

        var registration =
            healthOptions.Registrations.Single(
                candidate =>
                    candidate.Name ==
                    "kent-rehberi-data");

        Assert.Contains(
            ApiPlatformDefaults.ReadinessTag,
            registration.Tags);
    }

    private static IConfiguration
        BuildConfiguration(
            IDictionary<string, string?> values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(
                values)
            .Build();
}
