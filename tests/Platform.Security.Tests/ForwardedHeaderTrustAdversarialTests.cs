using Api.Core.Platform;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using AspNetCoreIPNetwork = Microsoft.AspNetCore.HttpOverrides.IPNetwork;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ForwardedHeaderTrustAdversarialTests
{
    [Theory]
    [InlineData(" 203.0.113.10 ", "203.0.113.10")]
    [InlineData(" 2001:db8::10 ", "2001:db8::10")]
    public void Build_TrimsConfiguredProxyAddresses(string configured, string expected)
    {
        var result = Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:KnownProxies:0"] = configured });
        Assert.Contains(IPAddress.Parse(expected), result.KnownProxies);
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    [InlineData("10.0.0.1")]
    [InlineData("172.16.1.1")]
    [InlineData("192.168.1.1")]
    [InlineData("169.254.1.1")]
    public void Build_AllowsExplicitNonUnspecifiedProxyAddresses(string address)
    {
        var result = Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:KnownProxies:0"] = address });
        Assert.Contains(IPAddress.Parse(address), result.KnownProxies);
    }

    [Theory]
    [InlineData("203.0.113.0/24")]
    [InlineData("198.51.100.128/25")]
    [InlineData("10.0.0.0/8")]
    [InlineData("2001:db8::/32")]
    [InlineData("2001:db8:abcd::/48")]
    [InlineData("fd00::/8")]
    public void Build_AllowsExplicitBoundedNetworks(string network)
    {
        var result = Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = network });
        Assert.Contains(AspNetCoreIPNetwork.Parse(network), result.KnownIPNetworks);
    }

    [Theory]
    [InlineData("203.0.113.0")]
    [InlineData("203.0.113.0/-1")]
    [InlineData("203.0.113.0/33")]
    [InlineData("2001:db8::/129")]
    [InlineData("2001:db8::/-1")]
    [InlineData("garbage/24")]
    public void Build_RejectsMalformedNetworks(string network)
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = network }));
    }

    [Theory]
    [InlineData("203.0.113.10\n")]
    [InlineData("203.0.113.10\r")]
    [InlineData("203.0.113.10\t198.51.100.1")]
    [InlineData("203.0.113.10,198.51.100.1")]
    [InlineData("203.0.113.10 198.51.100.1")]
    public void Build_RejectsCompositeOrControlBearingProxyValues(string address)
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:KnownProxies:0"] = address }));
    }

    [Fact]
    public void Build_DeduplicatesIpv6ProxyTextualForms()
    {
        var result = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "2001:db8::1",
            ["Platform:ForwardedHeaders:KnownProxies:1"] = "2001:0db8:0:0:0:0:0:1"
        });
        Assert.Single(result.KnownProxies.Where(address => address.Equals(IPAddress.Parse("2001:db8::1"))));
    }

    [Fact]
    public void Build_DeduplicatesNetworkTextualForms()
    {
        var result = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "2001:db8::/32",
            ["Platform:ForwardedHeaders:KnownIPNetworks:1"] = "2001:0db8:0000:0000::/32"
        });
        Assert.Single(result.KnownIPNetworks.Where(network => network.Equals(AspNetCoreIPNetwork.Parse("2001:db8::/32"))));
    }

    [Fact]
    public void Build_ExactProxyCardinalityLimitIsAccepted()
    {
        var values = new Dictionary<string, string?>();
        for (var index = 0; index < ForwardedHeaderTrustPolicy.MaxTrustedProxyEntries; index++) values[$"Platform:ForwardedHeaders:KnownProxies:{index}"] = $"192.0.2.{index + 1}";
        var result = Build(values);
        foreach (var value in values.Values) Assert.Contains(IPAddress.Parse(value!), result.KnownProxies);
    }

    [Fact]
    public void Build_ExactNetworkCardinalityLimitIsAccepted()
    {
        var values = new Dictionary<string, string?>();
        for (var index = 0; index < ForwardedHeaderTrustPolicy.MaxTrustedNetworkEntries; index++) values[$"Platform:ForwardedHeaders:KnownIPNetworks:{index}"] = $"10.{index}.0.0/16";
        var result = Build(values);
        foreach (var value in values.Values) Assert.Contains(AspNetCoreIPNetwork.Parse(value!), result.KnownIPNetworks);
    }

    [Fact]
    public void Build_DuplicateEntriesStillConsumeConfiguredCardinalityBudget()
    {
        var values = new Dictionary<string, string?>();
        for (var index = 0; index <= ForwardedHeaderTrustPolicy.MaxTrustedProxyEntries; index++) values[$"Platform:ForwardedHeaders:KnownProxies:{index}"] = "203.0.113.10";
        Assert.Throws<OptionsValidationException>(() => Build(values));
    }

    [Fact]
    public void Build_DuplicateNetworksStillConsumeConfiguredCardinalityBudget()
    {
        var values = new Dictionary<string, string?>();
        for (var index = 0; index <= ForwardedHeaderTrustPolicy.MaxTrustedNetworkEntries; index++) values[$"Platform:ForwardedHeaders:KnownIPNetworks:{index}"] = "198.51.100.0/24";
        Assert.Throws<OptionsValidationException>(() => Build(values));
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    [InlineData("TRUE", true)]
    [InlineData("FALSE", false)]
    [InlineData(" True ", true)]
    [InlineData(" False ", false)]
    public void Build_HeaderSymmetryParsingIsExplicitAndCaseInsensitive(string configured, bool expected)
    {
        var result = Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:RequireHeaderSymmetry"] = configured });
        Assert.Equal(expected, result.RequireHeaderSymmetry);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(4)]
    [InlineData(8)]
    public void Build_PreservesConfiguredForwardLimit(int limit)
    {
        var result = ForwardedHeaderTrustPolicy.Build(new ApiPlatformOptions.ForwardedHeaderOptions { Enabled = true, ForwardLimit = limit }, Configuration(null));
        Assert.Equal(limit, result.ForwardLimit);
    }

    [Fact]
    public void Build_NeverEnablesForwardedHost()
    {
        var result = Build(new Dictionary<string, string?> { ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10" });
        Assert.False(result.ForwardedHeaders.HasFlag(ForwardedHeaders.XForwardedHost));
        Assert.True(result.ForwardedHeaders.HasFlag(ForwardedHeaders.XForwardedFor));
        Assert.True(result.ForwardedHeaders.HasFlag(ForwardedHeaders.XForwardedProto));
    }

    [Fact]
    public void Build_DoesNotClearFrameworkDefaultTrustEntries()
    {
        var baseline = Build();
        var configured = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10",
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "198.51.100.0/24"
        });
        foreach (var proxy in baseline.KnownProxies) Assert.Contains(proxy, configured.KnownProxies);
        foreach (var network in baseline.KnownIPNetworks) Assert.Contains(network, configured.KnownIPNetworks);
    }

    [Fact]
    public void Build_ValidationFailureDoesNotExposeNeighboringConfigurationValues()
    {
        const string secretLikeValue = "should-never-appear-in-validation";
        var configuration = Configuration(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "not-an-ip",
            ["ConnectionStrings:Primary"] = secretLikeValue
        });
        var exception = Assert.Throws<OptionsValidationException>(() => ForwardedHeaderTrustPolicy.Build(new ApiPlatformOptions.ForwardedHeaderOptions(), configuration));
        Assert.DoesNotContain(secretLikeValue, exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Build_MultipleInvalidEntriesAreRejectedAsOnePolicyFailure()
    {
        var exception = Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "not-an-ip",
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "not-a-network",
            ["Platform:ForwardedHeaders:RequireHeaderSymmetry"] = "maybe"
        }));
        Assert.NotEmpty(exception.Failures);
    }

    private static Microsoft.AspNetCore.Builder.ForwardedHeadersOptions Build(IDictionary<string, string?>? values = null) =>
        ForwardedHeaderTrustPolicy.Build(new ApiPlatformOptions.ForwardedHeaderOptions { Enabled = true, ForwardLimit = 1 }, Configuration(values));

    private static IConfiguration Configuration(IDictionary<string, string?>? values)
    {
        var builder = new ConfigurationBuilder();
        if (values != null) builder.AddInMemoryCollection(values);
        return builder.Build();
    }
}
