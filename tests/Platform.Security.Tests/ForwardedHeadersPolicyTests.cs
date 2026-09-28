using Api.Core.Platform;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ForwardedHeadersPolicyTests
{
    private readonly ApiPlatformOptionsValidator validator = new();

    [Fact]
    public void Create_DefaultOptions_PreserveFrameworkLoopbackTrust()
    {
        var options = new ApiPlatformOptions.ForwardedHeaderOptions();

        var policy = ApiForwardedHeadersPolicy.Create(options);

        Assert.Equal(
            ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
            policy.ForwardedHeaders);
        Assert.Equal(1, policy.ForwardLimit);
        Assert.False(policy.RequireHeaderSymmetry);
        Assert.True(IsTrusted(policy, IPAddress.Loopback));
    }

    [Fact]
    public void Create_EmptyConfiguredLists_DoNotBecomeTrustAll()
    {
        var policy = ApiForwardedHeadersPolicy.Create(
            new ApiPlatformOptions.ForwardedHeaderOptions());

        Assert.False(IsTrusted(policy, IPAddress.Parse("203.0.113.45")));
        Assert.False(IsTrusted(policy, IPAddress.Parse("2001:db8::45")));
        Assert.True(IsTrusted(policy, IPAddress.Loopback));
    }

    [Fact]
    public void Create_AddsConfiguredExactProxiesAndNetworksWithoutDuplicates()
    {
        var options = new ApiPlatformOptions.ForwardedHeaderOptions
        {
            ForwardLimit = 2,
            RequireHeaderSymmetry = true
        };
        options.KnownProxies.Add("10.20.30.40");
        options.KnownProxies.Add("10.20.30.40");
        options.KnownProxies.Add("2001:db8::40");
        options.KnownIPNetworks.Add("10.40.0.0/16");
        options.KnownIPNetworks.Add("10.40.0.0/16");
        options.KnownIPNetworks.Add("2001:db8:40::/48");

        var policy = ApiForwardedHeadersPolicy.Create(options);

        Assert.Equal(2, policy.ForwardLimit);
        Assert.True(policy.RequireHeaderSymmetry);
        Assert.Equal(
            1,
            policy.KnownProxies.Count(
                address => address.Equals(IPAddress.Parse("10.20.30.40"))));
        Assert.Contains(
            IPAddress.Parse("2001:db8::40"),
            policy.KnownProxies);
        Assert.Equal(
            1,
            policy.KnownIPNetworks.Count(
                network => network.Equals(IPNetwork.Parse("10.40.0.0/16"))));
        Assert.Contains(
            IPNetwork.Parse("2001:db8:40::/48"),
            policy.KnownIPNetworks);
    }

    [Fact]
    public void Create_RejectsMalformedProxyEvenIfValidatorWasSkipped()
    {
        var options = new ApiPlatformOptions.ForwardedHeaderOptions();
        options.KnownProxies.Add("proxy.internal.example");

        var exception = Assert.Throws<InvalidOperationException>(
            () => ApiForwardedHeadersPolicy.Create(options));

        Assert.Contains("Invalid trusted", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    public void Create_RejectsUniversalNetworkEvenIfValidatorWasSkipped(string network)
    {
        var options = new ApiPlatformOptions.ForwardedHeaderOptions();
        options.KnownIPNetworks.Add(network);

        Assert.Throws<InvalidOperationException>(
            () => ApiForwardedHeadersPolicy.Create(options));
    }

    [Fact]
    public void ConfigurationResolver_BindsForwardedHeaderTrustLists()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Platform:ForwardedHeaders:Enabled"] = "true",
                ["Platform:ForwardedHeaders:ForwardLimit"] = "2",
                ["Platform:ForwardedHeaders:RequireHeaderSymmetry"] = "true",
                ["Platform:ForwardedHeaders:KnownProxies:0"] = "10.0.0.5",
                ["Platform:ForwardedHeaders:KnownProxies:1"] = "2001:db8::5",
                ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "10.10.0.0/16",
                ["Platform:ForwardedHeaders:KnownIPNetworks:1"] = "2001:db8:10::/48"
            })
            .Build();

        var resolved = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

        Assert.True(resolved.ForwardedHeaders.Enabled);
        Assert.Equal(2, resolved.ForwardedHeaders.ForwardLimit);
        Assert.True(resolved.ForwardedHeaders.RequireHeaderSymmetry);
        Assert.Equal(
            new[] { "10.0.0.5", "2001:db8::5" },
            resolved.ForwardedHeaders.KnownProxies);
        Assert.Equal(
            new[] { "10.10.0.0/16", "2001:db8:10::/48" },
            resolved.ForwardedHeaders.KnownIPNetworks);
    }

    [Fact]
    public void Validator_AcceptsValidIpv4AndIpv6TrustEntries()
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.ForwardLimit = 3;
        options.ForwardedHeaders.RequireHeaderSymmetry = true;
        options.ForwardedHeaders.KnownProxies.Add("10.0.0.10");
        options.ForwardedHeaders.KnownProxies.Add("2001:db8::10");
        options.ForwardedHeaders.KnownIPNetworks.Add("10.20.0.0/16");
        options.ForwardedHeaders.KnownIPNetworks.Add("2001:db8:20::/48");

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("proxy.example.test")]
    [InlineData("999.0.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    public void Validator_RejectsMalformedOrUnspecifiedTrustedProxy(string proxy)
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.KnownProxies.Add(proxy);

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "KnownProxies");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-network")]
    [InlineData("10.0.0.1/24")]
    [InlineData("10.0.0.0/33")]
    public void Validator_RejectsMalformedTrustedNetwork(string network)
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.KnownIPNetworks.Add(network);

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "KnownIPNetworks");
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    public void Validator_RejectsUniversalTrustNetwork(string network)
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.KnownIPNetworks.Add(network);

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "/0");
    }

    [Fact]
    public void Validator_RejectsOversizedCombinedTrustList()
    {
        var options = new ApiPlatformOptions();
        for (var index = 0;
             index <= ApiForwardedHeadersPolicy.MaxTrustedForwarderEntries;
             index++)
        {
            options.ForwardedHeaders.KnownProxies.Add(
                $"10.23.{index / 250}.{(index % 250) + 1}");
        }

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "cannot exceed");
    }

    [Fact]
    public void Validator_RejectsNullTrustCollectionsWhenEnabled()
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.KnownProxies = null!;
        options.ForwardedHeaders.KnownIPNetworks = null!;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "KnownProxies");
        AssertContainsFailure(result, "KnownIPNetworks");
    }

    [Fact]
    public void Validator_DisabledForwarding_IgnoresInactiveTrustConfiguration()
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.Enabled = false;
        options.ForwardedHeaders.ForwardLimit = 0;
        options.ForwardedHeaders.KnownProxies.Add("not-an-address");
        options.ForwardedHeaders.KnownIPNetworks.Add("not-a-network");

        Assert.True(Validate(options).Succeeded);
    }

    [Fact]
    public void Validator_RejectsCorrelationHeaderNameLongerThanSixtyFourCharacters()
    {
        var options = new ApiPlatformOptions();
        options.Requests.CorrelationHeaderName = "X-" + new string('A', 63);

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "CorrelationHeaderName");
    }

    [Fact]
    public void Validator_RejectsHealthPathWithControlCharacters()
    {
        var options = new ApiPlatformOptions();
        options.Health.LivenessPath = "/health/\nready";

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "LivenessPath");
    }

    private ValidateOptionsResult Validate(ApiPlatformOptions options)
    {
        return validator.Validate(Options.DefaultName, options);
    }

    private static bool IsTrusted(
        Microsoft.AspNetCore.Builder.ForwardedHeadersOptions policy,
        IPAddress address)
    {
        return policy.KnownProxies.Contains(address) ||
               policy.KnownIPNetworks.Any(network => network.Contains(address));
    }

    private static void AssertContainsFailure(
        ValidateOptionsResult result,
        string fragment)
    {
        Assert.Contains(
            result.Failures ?? Array.Empty<string>(),
            failure => failure.Contains(fragment, StringComparison.OrdinalIgnoreCase));
    }
}
