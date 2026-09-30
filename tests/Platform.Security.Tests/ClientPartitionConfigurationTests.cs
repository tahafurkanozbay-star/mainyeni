using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ClientPartitionConfigurationTests
{
    [Fact]
    public void ResolveOptions_DefaultsToAuthenticatedStablePartitioning()
    {
        var options = Resolve();

        Assert.NotNull(options.ClientPartitioning);
        Assert.True(options.ClientPartitioning.PartitionAuthenticatedUsers);
        Assert.Equal(64, options.ClientPartitioning.AnonymousIpv6PrefixLength);
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    [InlineData("TRUE", true)]
    [InlineData("FALSE", false)]
    public void ResolveOptions_BindsModernAuthenticatedPartitionSwitch(string value, bool expected)
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:PartitionAuthenticatedUsers"] = value
        });

        Assert.Equal(expected, options.ClientPartitioning.PartitionAuthenticatedUsers);
    }

    [Theory]
    [InlineData("48")]
    [InlineData("56")]
    [InlineData("64")]
    [InlineData("80")]
    [InlineData("96")]
    [InlineData("128")]
    public void ResolveOptions_BindsModernIpv6PrefixLength(string value)
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:AnonymousIpv6PrefixLength"] = value
        });

        Assert.Equal(int.Parse(value), options.ClientPartitioning.AnonymousIpv6PrefixLength);
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    public void ResolveOptions_LegacyRateLimitSwitchBridgesWhenModernValueAbsent(string value, bool expected)
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:RateLimiting:PartitionAuthenticatedUsers"] = value
        });

        Assert.Equal(expected, options.ClientPartitioning.PartitionAuthenticatedUsers);
    }

    [Fact]
    public void ResolveOptions_ModernValueAlwaysWinsOverLegacyValue()
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:PartitionAuthenticatedUsers"] = "false",
            ["Platform:RateLimiting:PartitionAuthenticatedUsers"] = "true"
        });

        Assert.False(options.ClientPartitioning.PartitionAuthenticatedUsers);
    }

    [Fact]
    public void ResolveOptions_ModernTrueWinsOverLegacyFalse()
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:PartitionAuthenticatedUsers"] = "true",
            ["Platform:RateLimiting:PartitionAuthenticatedUsers"] = "false"
        });

        Assert.True(options.ClientPartitioning.PartitionAuthenticatedUsers);
    }

    [Theory]
    [InlineData("not-a-bool")]
    [InlineData("1")]
    [InlineData("yes")]
    public void ResolveOptions_MalformedLegacyValueCannotDisableModernDefault(string value)
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:RateLimiting:PartitionAuthenticatedUsers"] = value
        });

        Assert.True(options.ClientPartitioning.PartitionAuthenticatedUsers);
    }

    [Fact]
    public void ResolveOptions_DoesNotAliasClientPartitioningAndRateLimitOptions()
    {
        var options = Resolve();

        options.ClientPartitioning.PartitionAuthenticatedUsers = false;

        Assert.True(options.RateLimiting.PartitionAuthenticatedUsers);
    }

    [Fact]
    public void ResolveOptions_RepeatedResolutionProducesIndependentOptionGraphs()
    {
        var first = Resolve();
        var second = Resolve();

        first.ClientPartitioning.PartitionAuthenticatedUsers = false;
        first.ClientPartitioning.AnonymousIpv6PrefixLength = 96;

        Assert.True(second.ClientPartitioning.PartitionAuthenticatedUsers);
        Assert.Equal(64, second.ClientPartitioning.AnonymousIpv6PrefixLength);
    }

    [Fact]
    public void ResolveOptions_PartitionConfigurationDoesNotChangeRateLimitCapacity()
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:PartitionAuthenticatedUsers"] = "false",
            ["Platform:ClientPartitioning:AnonymousIpv6PrefixLength"] = "80"
        });

        Assert.Equal(120, options.RateLimiting.PermitLimit);
        Assert.Equal(120, options.RateLimiting.WindowSeconds);
        Assert.Equal(0, options.RateLimiting.QueueLimit);
    }

    [Fact]
    public void ResolveOptions_RateLimitCapacityDoesNotChangePartitionPolicy()
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:RateLimiting:PermitLimit"] = "777",
            ["Platform:RateLimiting:WindowSeconds"] = "9",
            ["Platform:RateLimiting:QueueLimit"] = "3"
        });

        Assert.True(options.ClientPartitioning.PartitionAuthenticatedUsers);
        Assert.Equal(64, options.ClientPartitioning.AnonymousIpv6PrefixLength);
        Assert.Equal(777, options.RateLimiting.PermitLimit);
        Assert.Equal(9, options.RateLimiting.WindowSeconds);
        Assert.Equal(3, options.RateLimiting.QueueLimit);
    }

    [Fact]
    public void ResolveOptions_PreservesOtherPlatformSectionsAlongsidePartitioning()
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:PartitionAuthenticatedUsers"] = "false",
            ["Platform:Requests:CorrelationHeaderName"] = " X-Correlation-Test ",
            ["Platform:ForwardedHeaders:ForwardLimit"] = "2",
            ["Platform:Governance:Concurrency:MaxConcurrentRequests"] = "321"
        });

        Assert.False(options.ClientPartitioning.PartitionAuthenticatedUsers);
        Assert.Equal("X-Correlation-Test", options.Requests.CorrelationHeaderName);
        Assert.Equal(2, options.ForwardedHeaders.ForwardLimit);
        Assert.Equal(321, options.Governance.Concurrency.MaxConcurrentRequests);
    }

    [Fact]
    public void ResolveOptions_NullConfigurationFailsBeforeBinding()
    {
        Assert.Throws<ArgumentNullException>(() => ApiPlatformConfigurationResolver.ResolveOptions(null!));
    }

    [Fact]
    public void ResolveOptions_EmptyConfigurationProducesNonNullNestedPolicies()
    {
        var options = Resolve();

        Assert.NotNull(options.ClientPartitioning);
        Assert.NotNull(options.RateLimiting);
        Assert.NotNull(options.ForwardedHeaders);
        Assert.NotNull(options.Governance);
        Assert.NotNull(options.Requests);
    }

    [Theory]
    [InlineData("48", false)]
    [InlineData("64", true)]
    [InlineData("96", false)]
    [InlineData("128", true)]
    public void ResolveOptions_CombinedModernValuesBindIndependently(string prefix, bool partitionUsers)
    {
        var options = Resolve(new Dictionary<string, string?>
        {
            ["Platform:ClientPartitioning:AnonymousIpv6PrefixLength"] = prefix,
            ["Platform:ClientPartitioning:PartitionAuthenticatedUsers"] = partitionUsers.ToString()
        });

        Assert.Equal(int.Parse(prefix), options.ClientPartitioning.AnonymousIpv6PrefixLength);
        Assert.Equal(partitionUsers, options.ClientPartitioning.PartitionAuthenticatedUsers);
    }

    private static ApiPlatformOptions Resolve(IDictionary<string, string?>? values = null)
    {
        var builder = new ConfigurationBuilder();
        if (values != null)
        {
            builder.AddInMemoryCollection(values);
        }

        return ApiPlatformConfigurationResolver.ResolveOptions(builder.Build());
    }
}
