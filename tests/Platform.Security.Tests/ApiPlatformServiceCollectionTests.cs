using Api.Core.Platform;
using Business.Core.Context;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiPlatformServiceCollectionTests
{
    [Fact]
    public void AddKentRehberiApiPlatform_ThrowsWhenConnectionStringIsMissing()
    {
        var services = new ServiceCollection();
        var configuration = BuildConfiguration(new Dictionary<string, string?>());

        var exception = Assert.Throws<InvalidOperationException>(
            () => services.AddKentRehberiApiPlatform(configuration));

        Assert.Contains("ConnectionStrings__Primary", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_ThrowsForUnsupportedDatabaseProvider()
    {
        var services = new ServiceCollection();
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent",
            ["Platform:Database:Provider"] = "MYSQL"
        });

        var exception = Assert.Throws<OptionsValidationException>(
            () => services.AddKentRehberiApiPlatform(configuration));

        Assert.Contains(exception.Failures, failure =>
            failure.Contains("Provider", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AddKentRehberiApiPlatform_ThrowsForInvalidOperationalOptionsBeforeServingTraffic()
    {
        var services = new ServiceCollection();
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent",
            ["Platform:Requests:TimeoutSeconds"] = "0",
            ["Platform:Cors:AllowedOrigins:0"] = "*"
        });

        var exception = Assert.Throws<OptionsValidationException>(
            () => services.AddKentRehberiApiPlatform(configuration));

        Assert.Contains(exception.Failures, failure =>
            failure.Contains("TimeoutSeconds", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(exception.Failures, failure =>
            failure.Contains("Wildcard", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AddKentRehberiApiPlatform_RegistersResolvedOptionsAsSingletonContract()
    {
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent",
            ["Platform:Requests:TimeoutSeconds"] = "45",
            ["Platform:Health:DatabaseTimeoutSeconds"] = "4",
            ["Platform:Cors:AllowedOrigins:0"] = "https://kent.example.test"
        });

        var direct = provider.GetRequiredService<ApiPlatformOptions>();
        var wrapped = provider.GetRequiredService<IOptions<ApiPlatformOptions>>().Value;

        Assert.Same(direct, wrapped);
        Assert.Equal(45, direct.Requests.TimeoutSeconds);
        Assert.Equal(4, direct.Health.DatabaseTimeoutSeconds);
        Assert.Single(direct.Cors.AllowedOrigins);
        Assert.Equal("https://kent.example.test", direct.Cors.AllowedOrigins[0]);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_RegistersPooledBusinessContextUsingNpgsql()
    {
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Port=5432;Database=kent;Username=test;Password=test"
        });

        using var scope = provider.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<BusinessContext>();

        Assert.Equal("Npgsql.EntityFrameworkCore.PostgreSQL", context.Database.ProviderName);
        Assert.Contains("Database=kent", context.Database.GetConnectionString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_AcceptsLegacyConnectionSectionAsTemporaryBridge()
    {
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["Environment"] = "test",
            ["DbConfigTest:Type"] = "PGSQL",
            ["DbConfigTest:ConnectionString"] = "Host=legacy;Database=kent;Username=test;Password=test"
        });

        using var scope = provider.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<BusinessContext>();

        Assert.Contains("Host=legacy", context.Database.GetConnectionString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_RegistersHealthServiceWhenHealthIsEnabled()
    {
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent",
            ["Platform:Health:Enabled"] = "true"
        });

        Assert.NotNull(provider.GetService<HealthCheckService>());
    }

    [Fact]
    public void AddKentRehberiApiPlatform_RegistersHttpContextAccessor()
    {
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent"
        });

        Assert.NotNull(provider.GetService<Microsoft.AspNetCore.Http.IHttpContextAccessor>());
    }

    [Fact]
    public void AddKentRehberiApiPlatform_DoesNotMaterializeDatabaseConnectionDuringRegistration()
    {
        var services = new ServiceCollection();
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=definitely-not-a-real-host.invalid;Database=kent;Username=test;Password=test"
        });

        var returned = services.AddKentRehberiApiPlatform(configuration);
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<BusinessContext>();

        Assert.Same(services, returned);
        Assert.Equal("Npgsql.EntityFrameworkCore.PostgreSQL", context.Database.ProviderName);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_ReturnsSameServiceCollectionForFluentRegistration()
    {
        var services = new ServiceCollection();
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent"
        });

        var result = services.AddKentRehberiApiPlatform(configuration);

        Assert.Same(services, result);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_ThrowsForNullServiceCollection()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent"
        });

        IServiceCollection? services = null;
        Assert.Throws<ArgumentNullException>(() =>
            ApiPlatformServiceCollectionExtensions.AddKentRehberiApiPlatform(services!, configuration));
    }

    [Fact]
    public void AddKentRehberiApiPlatform_ThrowsForNullConfiguration()
    {
        var services = new ServiceCollection();

        Assert.Throws<ArgumentNullException>(() => services.AddKentRehberiApiPlatform(null!));
    }

    [Fact]
    public void AddKentRehberiApiPlatform_DeduplicatesCorsOriginsCaseInsensitively()
    {
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent",
            ["Platform:Cors:AllowedOrigins:0"] = "https://kent.example.test",
            ["Cors:AllowedOrigins:0"] = "https://KENT.example.test/"
        });

        var options = provider.GetRequiredService<ApiPlatformOptions>();

        Assert.Single(options.Cors.AllowedOrigins);
    }

    [Fact]
    public void AddKentRehberiApiPlatform_UsesConfiguredDatabaseRuntimeBounds()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=localhost;Database=kent",
            ["Platform:Database:CommandTimeoutSeconds"] = "47",
            ["Platform:Database:RetryCount"] = "5",
            ["Platform:Database:RetryMaxDelaySeconds"] = "9"
        });

        var resolved = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);
        var provider = BuildProvider(configuration);
        using var scope = provider.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<BusinessContext>();

        Assert.Equal(47, resolved.CommandTimeoutSeconds);
        Assert.Equal(5, resolved.RetryCount);
        Assert.Equal(9, resolved.RetryMaxDelaySeconds);
        Assert.Equal(47, context.Database.GetCommandTimeout());
    }

    [Fact]
    public void RegisteredOptions_DoNotContainDatabaseSecret()
    {
        const string secret = "very-secret-database-password";
        var provider = BuildProvider(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = $"Host=localhost;Database=kent;Username=test;Password={secret}"
        });

        var options = provider.GetRequiredService<ApiPlatformOptions>();
        var optionStrings = new[]
        {
            options.Database.Provider,
            options.Requests.CorrelationHeaderName,
            options.Health.LivenessPath,
            options.Health.ReadinessPath
        };

        Assert.DoesNotContain(optionStrings, value =>
            value != null && value.Contains(secret, StringComparison.Ordinal));
    }

    private static ServiceProvider BuildProvider(Dictionary<string, string?> values)
    {
        return BuildProvider(BuildConfiguration(values));
    }

    private static ServiceProvider BuildProvider(IConfiguration configuration)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddKentRehberiApiPlatform(configuration);
        return services.BuildServiceProvider();
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
    {
        return new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
    }
}
