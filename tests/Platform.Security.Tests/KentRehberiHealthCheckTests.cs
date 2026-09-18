using Api.Core.Platform;
using Api.User.KentRehberi;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiHealthCheckTests
{
    [Fact]
    public async Task DisabledDataSource_IsHealthyWithoutConnectionString()
    {
        var options = new KentRehberiOptions
        {
            Enabled = false
        };
        var configuration = BuildConfiguration(
            new Dictionary<string, string?>());
        var factory = new KentRehberiConnectionFactory(
            configuration,
            options);
        var healthCheck = new KentRehberiHealthCheck(
            factory,
            options);

        var result = await healthCheck.CheckHealthAsync(
            new HealthCheckContext());

        Assert.Equal(HealthStatus.Healthy, result.Status);
        Assert.Contains(
            "disabled",
            result.Description,
            System.StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task EnabledDataSource_WithoutServerSecret_IsUnhealthy()
    {
        var options = new KentRehberiOptions
        {
            Enabled = true
        };
        var configuration = BuildConfiguration(
            new Dictionary<string, string?>());
        var factory = new KentRehberiConnectionFactory(
            configuration,
            options);
        var healthCheck = new KentRehberiHealthCheck(
            factory,
            options);

        var result = await healthCheck.CheckHealthAsync(
            new HealthCheckContext());

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.Contains(
            "not configured",
            result.Description,
            System.StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ServiceRegistration_AddsDedicatedReadinessProbe()
    {
        var services = new ServiceCollection();
        var configuration = BuildConfiguration(
            new Dictionary<string, string?>
            {
                ["KentRehberiData:Enabled"] = "true"
            });

        services.AddKentRehberiData(configuration);

        using var provider = services.BuildServiceProvider();
        var healthOptions = provider
            .GetRequiredService<IOptions<HealthCheckServiceOptions>>()
            .Value;

        var registration = Assert.Single(
            healthOptions.Registrations,
            candidate => candidate.Name == "kent-rehberi-data");

        Assert.Contains(
            ApiPlatformDefaults.ReadinessTag,
            registration.Tags);
    }

    private static IConfiguration BuildConfiguration(
        IDictionary<string, string?> values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
}
