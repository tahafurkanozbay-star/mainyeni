using Api.Core.Platform;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ForwardedHeaderNetworkRuntimeContractTests
{
    [Theory]
    [InlineData("192.0.2.0/24", "192.0.2.0/24")]
    [InlineData("198.51.100.128/25", "198.51.100.128/25")]
    [InlineData("2001:db8::/32", "2001:db8::/32")]
    [InlineData("2001:db8:abcd::/48", "2001:db8:abcd::/48")]
    public void Build_UsesSystemNetIpNetworkValues(string configured, string expected)
    {
        ForwardedHeadersOptions result = Build(configured);
        IPNetwork expectedNetwork = IPNetwork.Parse(expected);

        Assert.Contains(expectedNetwork, result.KnownIPNetworks);
        Assert.All(result.KnownIPNetworks, network => Assert.IsType<IPNetwork>(network));
    }

    [Theory]
    [InlineData(" 192.0.2.0/24 ")]
    [InlineData("\t198.51.100.0/24\t")]
    [InlineData(" 2001:db8::/32 ")]
    public void Build_TrimsNetworkConfigurationBeforeRuntimeParsing(string configured)
    {
        var result = Build(configured);
        var normalized = configured.Trim();

        Assert.Contains(IPNetwork.Parse(normalized), result.KnownIPNetworks);
    }

    [Fact]
    public void Build_CanonicalEquivalentNetworksCollapseToOneConfiguredEntry()
    {
        var configuration = Configuration(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "2001:db8::/32",
            ["Platform:ForwardedHeaders:KnownIPNetworks:1"] = "2001:0db8:0000:0000::/32"
        });

        var baseline = ForwardedHeaderTrustPolicy.Build(new ApiPlatformOptions.ForwardedHeaderOptions { Enabled = true }, Configuration());
        var result = ForwardedHeaderTrustPolicy.Build(new ApiPlatformOptions.ForwardedHeaderOptions { Enabled = true }, configuration);
        var configured = IPNetwork.Parse("2001:db8::/32");

        Assert.Contains(configured, result.KnownIPNetworks);
        Assert.Equal(
            baseline.KnownIPNetworks.Count(network => network.Equals(configured)) + 1,
            result.KnownIPNetworks.Count(network => network.Equals(configured)));
    }

    [Theory]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    public void Build_DoesNotPermitTrustAllNetworks(string configured)
    {
        var exception = Assert.Throws<Microsoft.Extensions.Options.OptionsValidationException>(() => Build(configured));

        Assert.Contains("cannot trust an all-addresses network", exception.Message, StringComparison.Ordinal);
    }

    private static ForwardedHeadersOptions Build(string network)
    {
        return ForwardedHeaderTrustPolicy.Build(
            new ApiPlatformOptions.ForwardedHeaderOptions { Enabled = true, ForwardLimit = 1 },
            Configuration(new Dictionary<string, string?>
            {
                ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = network
            }));
    }

    private static IConfiguration Configuration(IDictionary<string, string?>? values = null)
    {
        var builder = new ConfigurationBuilder();
        if (values != null)
        {
            builder.AddInMemoryCollection(values);
        }

        return builder.Build();
    }
}
