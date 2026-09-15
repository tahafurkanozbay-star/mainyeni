using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using System.Collections.Generic;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiPlatformConfigurationResolverTests
{
    [Fact]
    public void ResolveDatabase_UsesPrimaryConnectionStringAndPostgreSqlDefaults()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=db;Database=kent;Username=app;Password=secret"
        });

        var result = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);

        Assert.True(result.IsConfigured);
        Assert.Equal("PGSQL", result.Provider);
        Assert.Equal("ConnectionStrings:Primary", result.Source);
        Assert.Equal("Host=db;Database=kent;Username=app;Password=secret", result.ConnectionString);
        Assert.Equal(30, result.CommandTimeoutSeconds);
        Assert.Equal(3, result.RetryCount);
        Assert.Equal(5, result.RetryMaxDelaySeconds);
    }

    [Fact]
    public void ResolveDatabase_PrefersModernPrimaryConnectionStringOverLegacySections()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Environment"] = "prod",
            ["ConnectionStrings:Primary"] = "Host=modern;Database=kent",
            ["DbConfigProd:ConnectionString"] = "Host=legacy;Database=kent",
            ["DbConfigProd:Type"] = "MYSQL"
        });

        var result = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);

        Assert.Equal("Host=modern;Database=kent", result.ConnectionString);
        Assert.Equal("PGSQL", result.Provider);
        Assert.Equal("ConnectionStrings:Primary", result.Source);
    }

    [Fact]
    public void ResolveDatabase_UsesProductionLegacySectionOnlyWhenPrimaryIsMissing()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Environment"] = "prod",
            ["DbConfigProd:ConnectionString"] = "Host=prod-legacy;Database=kent",
            ["DbConfigProd:Type"] = "pgsql",
            ["DbConfigTest:ConnectionString"] = "Host=test-legacy;Database=kent"
        });

        var result = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);

        Assert.True(result.IsConfigured);
        Assert.Equal("Host=prod-legacy;Database=kent", result.ConnectionString);
        Assert.Equal("PGSQL", result.Provider);
        Assert.Equal("DbConfigProd:ConnectionString", result.Source);
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("production")]
    [InlineData("PRODUCTION")]
    [InlineData("prod")]
    [InlineData("PROD")]
    public void ResolveDatabase_RecognizesProductionEnvironmentAliases(string environment)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Environment"] = environment,
            ["DbConfigProd:ConnectionString"] = "Host=prod;Database=kent",
            ["DbConfigTest:ConnectionString"] = "Host=test;Database=kent"
        });

        var result = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);

        Assert.Equal("Host=prod;Database=kent", result.ConnectionString);
        Assert.True(ApiPlatformConfigurationResolver.IsProduction(configuration));
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Staging")]
    [InlineData("test")]
    [InlineData("")]
    public void ResolveDatabase_UsesLegacyTestSectionOutsideProduction(string environment)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Environment"] = environment,
            ["DbConfigProd:ConnectionString"] = "Host=prod;Database=kent",
            ["DbConfigTest:ConnectionString"] = "Host=test;Database=kent"
        });

        var result = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);

        Assert.Equal("Host=test;Database=kent", result.ConnectionString);
        Assert.False(ApiPlatformConfigurationResolver.IsProduction(configuration));
    }

    [Fact]
    public void IsProduction_PrefersAspNetCoreEnvironment()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
            ["DOTNET_ENVIRONMENT"] = "Development",
            ["Environment"] = "test"
        });

        Assert.True(ApiPlatformConfigurationResolver.IsProduction(configuration));
    }

    [Fact]
    public void IsProduction_UsesDotNetEnvironmentWhenAspNetCoreValueIsMissing()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["DOTNET_ENVIRONMENT"] = "Production",
            ["Environment"] = "test"
        });

        Assert.True(ApiPlatformConfigurationResolver.IsProduction(configuration));
    }

    [Fact]
    public void ResolveDatabase_NormalizesConfiguredProvider()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=db;Database=kent",
            ["Platform:Database:Provider"] = " pgsql "
        });

        Assert.Equal("PGSQL", ApiPlatformConfigurationResolver.ResolveDatabase(configuration).Provider);
    }

    [Fact]
    public void ResolveDatabase_UsesLegacyDatabaseProviderKeyAsCompatibilityFallback()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=db;Database=kent",
            ["Database:Provider"] = "pgsql"
        });

        Assert.Equal("PGSQL", ApiPlatformConfigurationResolver.ResolveDatabase(configuration).Provider);
    }

    [Fact]
    public void ResolveDatabase_ReturnsUnconfiguredResultInsteadOfInventingConnectionString()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>());

        var result = ApiPlatformConfigurationResolver.ResolveDatabase(configuration);

        Assert.False(result.IsConfigured);
        Assert.Null(result.ConnectionString);
        Assert.Equal("ConnectionStrings:Primary", result.Source);
    }

    [Theory]
    [InlineData("0", 1)]
    [InlineData("1", 1)]
    [InlineData("30", 30)]
    [InlineData("300", 300)]
    [InlineData("301", 300)]
    [InlineData("invalid", 30)]
    public void ResolveDatabase_BoundsCommandTimeout(string value, int expected)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=db;Database=kent",
            ["Platform:Database:CommandTimeoutSeconds"] = value
        });

        Assert.Equal(expected, ApiPlatformConfigurationResolver.ResolveDatabase(configuration).CommandTimeoutSeconds);
    }

    [Theory]
    [InlineData("-1", 0)]
    [InlineData("0", 0)]
    [InlineData("3", 3)]
    [InlineData("10", 10)]
    [InlineData("11", 10)]
    [InlineData("invalid", 3)]
    public void ResolveDatabase_BoundsRetryCount(string value, int expected)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=db;Database=kent",
            ["Platform:Database:RetryCount"] = value
        });

        Assert.Equal(expected, ApiPlatformConfigurationResolver.ResolveDatabase(configuration).RetryCount);
    }

    [Theory]
    [InlineData("0", 1)]
    [InlineData("1", 1)]
    [InlineData("5", 5)]
    [InlineData("60", 60)]
    [InlineData("61", 60)]
    [InlineData("invalid", 5)]
    public void ResolveDatabase_BoundsRetryDelay(string value, int expected)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Primary"] = "Host=db;Database=kent",
            ["Platform:Database:RetryMaxDelaySeconds"] = value
        });

        Assert.Equal(expected, ApiPlatformConfigurationResolver.ResolveDatabase(configuration).RetryMaxDelaySeconds);
    }

    [Fact]
    public void ResolveAllowedOrigins_MergesModernAndLegacyWithoutDuplicates()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Platform:Cors:AllowedOrigins:0"] = "https://kent.example.test/",
            ["Platform:Cors:AllowedOrigins:1"] = "https://admin.example.test",
            ["Cors:AllowedOrigins:0"] = "https://KENT.example.test",
            ["Cors:AllowedOrigins:1"] = " http://localhost:3000/ "
        });

        var origins = ApiPlatformConfigurationResolver.ResolveAllowedOrigins(configuration);

        Assert.Equal(3, origins.Count);
        Assert.Contains("https://kent.example.test", origins);
        Assert.Contains("https://admin.example.test", origins);
        Assert.Contains("http://localhost:3000", origins);
    }

    [Fact]
    public void ResolveAllowedOrigins_DropsBlankValues()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Platform:Cors:AllowedOrigins:0"] = "",
            ["Platform:Cors:AllowedOrigins:1"] = "  ",
            ["Platform:Cors:AllowedOrigins:2"] = "https://kent.example.test"
        });

        var origins = ApiPlatformConfigurationResolver.ResolveAllowedOrigins(configuration);

        Assert.Single(origins);
        Assert.Equal("https://kent.example.test", origins[0]);
    }

    [Fact]
    public void ResolveOptions_BindsOperationalOverridesAndNormalizesPaths()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Platform:Database:Provider"] = "pgsql",
            ["Platform:Database:CommandTimeoutSeconds"] = "42",
            ["Platform:Database:RetryCount"] = "4",
            ["Platform:Database:RetryMaxDelaySeconds"] = "7",
            ["Platform:Requests:TimeoutSeconds"] = "55",
            ["Platform:Requests:MaxRequestBodyBytes"] = "4096",
            ["Platform:Requests:MaxCorrelationIdLength"] = "64",
            ["Platform:Requests:CorrelationHeaderName"] = " X-Request-ID ",
            ["Platform:Health:LivenessPath"] = "health/live",
            ["Platform:Health:ReadinessPath"] = "/health/ready/custom",
            ["Platform:Health:DatabaseTimeoutSeconds"] = "8",
            ["Platform:ForwardedHeaders:ForwardLimit"] = "2",
            ["Platform:Cors:AllowedOrigins:0"] = "https://kent.example.test/"
        });

        var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

        Assert.Equal("PGSQL", options.Database.Provider);
        Assert.Equal(42, options.Database.CommandTimeoutSeconds);
        Assert.Equal(4, options.Database.RetryCount);
        Assert.Equal(7, options.Database.RetryMaxDelaySeconds);
        Assert.Equal(55, options.Requests.TimeoutSeconds);
        Assert.Equal(4096, options.Requests.MaxRequestBodyBytes);
        Assert.Equal(64, options.Requests.MaxCorrelationIdLength);
        Assert.Equal("X-Request-ID", options.Requests.CorrelationHeaderName);
        Assert.Equal("/health/live", options.Health.LivenessPath);
        Assert.Equal("/health/ready/custom", options.Health.ReadinessPath);
        Assert.Equal(8, options.Health.DatabaseTimeoutSeconds);
        Assert.Equal(2, options.ForwardedHeaders.ForwardLimit);
        Assert.Single(options.Cors.AllowedOrigins);
        Assert.Equal("https://kent.example.test", options.Cors.AllowedOrigins[0]);
    }

    [Fact]
    public void ResolveOptions_RestoresDefaultCorrelationHeaderWhenConfiguredValueIsBlank()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Platform:Requests:CorrelationHeaderName"] = "  "
        });

        var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

        Assert.Equal(ApiPlatformDefaults.CorrelationHeaderName, options.Requests.CorrelationHeaderName);
    }

    [Fact]
    public void ResolveMethods_ThrowForNullConfiguration()
    {
        Assert.Throws<System.ArgumentNullException>(() => ApiPlatformConfigurationResolver.ResolveDatabase(null!));
        Assert.Throws<System.ArgumentNullException>(() => ApiPlatformConfigurationResolver.ResolveAllowedOrigins(null!));
        Assert.Throws<System.ArgumentNullException>(() => ApiPlatformConfigurationResolver.ResolveOptions(null!));
        Assert.False(ApiPlatformConfigurationResolver.IsProduction(null!));
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
    {
        return new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
    }
}
