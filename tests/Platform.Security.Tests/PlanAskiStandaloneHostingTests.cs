using Api.User.KentRehberi;
using Api.User.Platform;
using Business.Core.Context;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class PlanAskiStandaloneHostingTests
{
    [Fact]
    public void Standalone_WithoutPrimaryDatabase_ExposesOnlyKentRehberiController()
    {
        var configuration = Config();
        var services = new ServiceCollection();
        services.AddLogging();

        PlanAskiStandaloneHosting.AddServices(services, configuration);

        using var provider = services.BuildServiceProvider();
        var feature = new ControllerFeature();
        provider.GetRequiredService<ApplicationPartManager>()
            .PopulateFeature(feature);

        Assert.Single(feature.Controllers);
        Assert.Equal(
            typeof(KentRehberiController),
            feature.Controllers[0].AsType());
        Assert.Null(provider.GetService<BusinessContext>());
        Assert.NotNull(provider.GetRequiredService<IKentRehberiQueryService>());

        var checks = provider.GetRequiredService<
            IOptions<HealthCheckServiceOptions>>().Value.Registrations;
        Assert.Single(checks);
        Assert.Contains(checks, check => check.Name == "kent-rehberi-data");
        Assert.DoesNotContain(checks, check => check.Name == "database");
    }

    [Fact]
    public void DisabledStandalone_CannotRegisterServices()
    {
        var services = new ServiceCollection();
        Assert.Throws<InvalidOperationException>(
            () => PlanAskiStandaloneHosting.AddServices(
                services,
                Config(("KentRehberiData:Standalone", "false"))));
    }

    [Theory]
    [InlineData("Postgis", "true")]
    [InlineData("PlanAski", "false")]
    public void Standalone_RejectsOtherSourceOrDisabledData(
        string source,
        string enabled)
    {
        var services = new ServiceCollection();

        Assert.Throws<InvalidOperationException>(
            () => PlanAskiStandaloneHosting.AddServices(
                services,
                Config(
                    ("KentRehberiData:Source", source),
                    ("KentRehberiData:Enabled", enabled))));
    }

    [Fact]
    public void Standalone_RejectsUnpinnedUpstream()
    {
        var services = new ServiceCollection();

        Assert.Throws<InvalidOperationException>(
            () => PlanAskiStandaloneHosting.AddServices(
                services,
                Config((
                    "KentRehberiData:PlanAskiBaseUri",
                    "https://example.invalid/kentrehberiapi/api/kentrehberi"))));
    }

    private static IConfiguration Config(
        params (string Key, string Value)[] overrides)
    {
        var settings = new Dictionary<string, string?>
        {
            ["KentRehberiData:Standalone"] = "true",
            ["KentRehberiData:Enabled"] = "true",
            ["KentRehberiData:Source"] = "PlanAski",
            ["ConnectionStrings:Primary"] = ""
        };

        foreach (var (key, value) in overrides)
        {
            settings[key] = value;
        }

        return new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();
    }
}
