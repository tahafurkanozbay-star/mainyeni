using Api.User.KentRehberi;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiRuntimeConfigurationTests
{
    [Fact]
    public void DefaultRuntimeOptions_AreValid()
    {
        var options = new KentRehberiOptions();

        Assert.Empty(options.Validate());
        Assert.True(options.ResultCacheEnabled);
        Assert.True(options.ResultCacheMaxEntries > 0);
        Assert.True(options.ResultCacheMaxBytes > 0);
        Assert.True(options.MaxConcurrentQueries > 0);
        Assert.True(options.MaxQueuedQueries >= 0);
        Assert.True(options.QueryDeadlineMilliseconds > 0);
        Assert.True(options.MaxResponseBytes > 0);
        Assert.True(options.MaxGeometryNodesPerResponse >=
                    options.MaxGeometryNodesPerFeature);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(601)]
    public void CacheTtlOutsideBounds_IsRejected(
        int value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.ResultCacheTtlSeconds = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "ResultCacheTtlSeconds",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(4097)]
    public void CacheEntriesOutsideBounds_IsRejected(
        int value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.ResultCacheMaxEntries = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "ResultCacheMaxEntries",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(1048575)]
    [InlineData(268435457)]
    public void CacheBytesOutsideBounds_IsRejected(
        long value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.ResultCacheMaxBytes = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "ResultCacheMaxBytes",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(129)]
    public void ConcurrencyOutsideBounds_IsRejected(
        int value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.MaxConcurrentQueries = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "MaxConcurrentQueries",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(4097)]
    public void QueueOutsideBounds_IsRejected(
        int value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.MaxQueuedQueries = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "MaxQueuedQueries",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(249)]
    [InlineData(60001)]
    public void DeadlineOutsideBounds_IsRejected(
        int value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.QueryDeadlineMilliseconds = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "QueryDeadlineMilliseconds",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(262143)]
    [InlineData(67108865)]
    public void ResponseBytesOutsideBounds_IsRejected(
        long value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.MaxResponseBytes = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "MaxResponseBytes",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void FeatureBudgetCannotBeLowerThanPublicLimit()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                {
                    item.MaxLimit = 100;
                    item.MaxResponseFeatures = 99;
                });

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "cannot be lower than MaxLimit",
                    StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(3)]
    [InlineData(129)]
    public void GeometryDepthOutsideBounds_IsRejected(
        int value)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                    item.MaxGeometryDepth = value);

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "MaxGeometryDepth",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ResponseGeometryBudgetCannotBeBelowFeatureBudget()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                item =>
                {
                    item.MaxGeometryNodesPerFeature = 5000;
                    item.MaxGeometryNodesPerResponse = 4999;
                });

        Assert.Contains(
            options.Validate(),
            failure =>
                failure.Contains(
                    "MaxGeometryNodesPerResponse cannot",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void Registration_AddsAllResilienceServices()
    {
        var services =
            new ServiceCollection();
        var configuration =
            new ConfigurationBuilder()
                .AddInMemoryCollection(
                    new Dictionary<string, string?>
                    {
                        ["KentRehberiData:Enabled"] = "false"
                    })
                .Build();

        services.AddKentRehberiData(
            configuration);

        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(KentRehberiTelemetry));
        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(KentRehberiAdmissionController));
        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(KentRehberiBoundedResultCache));
        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(KentRehberiResultIntegrityGuard));
        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(
                    KentRehberiSingleFlight<
                        KentRehberiFeatureCollection>));
        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(
                    KentRehberiSingleFlight<
                        KentRehberiFeature?>));
        Assert.Contains(
            services,
            descriptor =>
                descriptor.ServiceType ==
                typeof(IKentRehberiQueryService) &&
                descriptor.Lifetime ==
                ServiceLifetime.Scoped);
    }

    [Fact]
    public void Registration_UsesSingletonSharedRuntimePrimitives()
    {
        var services =
            new ServiceCollection();
        var configuration =
            new ConfigurationBuilder()
                .AddInMemoryCollection(
                    new Dictionary<string, string?>
                    {
                        ["KentRehberiData:Enabled"] = "false"
                    })
                .Build();

        services.AddKentRehberiData(
            configuration);

        var sharedTypes = new[]
        {
            typeof(KentRehberiTelemetry),
            typeof(KentRehberiAdmissionController),
            typeof(KentRehberiBoundedResultCache),
            typeof(KentRehberiResultIntegrityGuard)
        };

        foreach (var type in sharedTypes)
        {
            var descriptor =
                services.Single(
                    item =>
                        item.ServiceType == type);

            Assert.Equal(
                ServiceLifetime.Singleton,
                descriptor.Lifetime);
        }
    }

    [Fact]
    public void InvalidRuntimeConfiguration_FailsRegistrationClosed()
    {
        var services =
            new ServiceCollection();
        var configuration =
            new ConfigurationBuilder()
                .AddInMemoryCollection(
                    new Dictionary<string, string?>
                    {
                        ["KentRehberiData:Enabled"] = "true",
                        ["KentRehberiData:MaxConcurrentQueries"] = "0"
                    })
                .Build();

        var error =
            Assert.Throws<InvalidOperationException>(
                () =>
                    services.AddKentRehberiData(
                        configuration));

        Assert.Contains(
            "MaxConcurrentQueries",
            error.Message,
            StringComparison.Ordinal);
    }
}
