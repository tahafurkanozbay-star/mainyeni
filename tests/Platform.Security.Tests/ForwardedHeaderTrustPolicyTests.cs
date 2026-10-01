using Api.Core.Platform;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ForwardedHeaderTrustPolicyTests
{
    [Fact]
    public void Build_EmptyExplicitTrust_RetainsFrameworkLoopbackDefaults()
    {
        var result = Build();

        Assert.Equal(1, result.ForwardLimit);
        Assert.False(result.RequireHeaderSymmetry);
        Assert.True(result.KnownProxies.Count + result.KnownIPNetworks.Count > 0);
    }

    [Fact]
    public void Build_AddsExactIpv4AndIpv6ProxiesWithoutRemovingDefaults()
    {
        var baseline = Build();
        var result = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10",
            ["Platform:ForwardedHeaders:KnownProxies:1"] = "2001:db8::10"
        });

        Assert.Contains(result.KnownProxies, value => value.Equals(IPAddress.Parse("203.0.113.10")));
        Assert.Contains(result.KnownProxies, value => value.Equals(IPAddress.Parse("2001:db8::10")));
        Assert.True(result.KnownProxies.Count >= baseline.KnownProxies.Count + 2);
    }

    [Fact]
    public void Build_AddsModernSystemNetIpNetworks()
    {
        var result = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "203.0.113.0/24",
            ["Platform:ForwardedHeaders:KnownIPNetworks:1"] = "2001:db8:1234::/48"
        });

        Assert.Contains(IPNetwork.Parse("203.0.113.0/24"), result.KnownIPNetworks);
        Assert.Contains(IPNetwork.Parse("2001:db8:1234::/48"), result.KnownIPNetworks);
    }

    [Fact]
    public void Build_DeduplicatesConfiguredTrustEntries()
    {
        var result = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10",
            ["Platform:ForwardedHeaders:KnownProxies:1"] = " 203.0.113.10 ",
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = "198.51.100.0/24",
            ["Platform:ForwardedHeaders:KnownIPNetworks:1"] = "198.51.100.0/24"
        });

        Assert.Single(result.KnownProxies.Where(value => value.Equals(IPAddress.Parse("203.0.113.10"))));
        Assert.Single(result.KnownIPNetworks.Where(value => value.Equals(IPNetwork.Parse("198.51.100.0/24"))));
    }

    [Fact]
    public void Build_AppliesForwardLimitAndOptionalHeaderSymmetry()
    {
        var platformOptions = new ApiPlatformOptions.ForwardedHeaderOptions
        {
            Enabled = true,
            ForwardLimit = 3
        };
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:RequireHeaderSymmetry"] = "true"
        });

        var result = ForwardedHeaderTrustPolicy.Build(platformOptions, configuration);

        Assert.Equal(3, result.ForwardLimit);
        Assert.True(result.RequireHeaderSymmetry);
    }

    [Theory]
    [InlineData("not-an-ip")]
    [InlineData("999.999.999.999")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    public void Build_RejectsInvalidOrUnspecifiedProxyAddress(string value)
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = value
        }));
    }

    [Theory]
    [InlineData("not-a-network")]
    [InlineData("203.0.113.0/99")]
    [InlineData("0.0.0.0/0")]
    [InlineData("::/0")]
    public void Build_RejectsInvalidOrTrustAllNetwork(string value)
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownIPNetworks:0"] = value
        }));
    }

    [Fact]
    public void Build_RejectsMalformedBoolean()
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:RequireHeaderSymmetry"] = "sometimes"
        }));
    }

    [Fact]
    public void Build_RejectsBlankTrustEntry()
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "   "
        }));
    }

    [Fact]
    public void Build_RejectsNewlineTrustEntry()
    {
        Assert.Throws<OptionsValidationException>(() => Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10\r\nX-Test: value"
        }));
    }

    [Fact]
    public void Build_BoundsExactProxyConfigurationCardinality()
    {
        var values = new Dictionary<string, string?>();
        for (var index = 0; index <= ForwardedHeaderTrustPolicy.MaxTrustedProxyEntries; index++)
        {
            values[$"Platform:ForwardedHeaders:KnownProxies:{index}"] = $"192.0.2.{(index % 250) + 1}";
        }

        Assert.Throws<OptionsValidationException>(() => Build(values));
    }

    [Fact]
    public void Build_BoundsNetworkConfigurationCardinality()
    {
        var values = new Dictionary<string, string?>();
        for (var index = 0; index <= ForwardedHeaderTrustPolicy.MaxTrustedNetworkEntries; index++)
        {
            values[$"Platform:ForwardedHeaders:KnownIPNetworks:{index}"] = $"10.{index}.0.0/16";
        }

        Assert.Throws<OptionsValidationException>(() => Build(values));
    }

    [Fact]
    public async Task Middleware_IgnoresForwardedIdentityFromUnknownProxy()
    {
        var result = await ExecuteAsync(
            Build(),
            remoteAddress: "203.0.113.10",
            forwardedFor: "198.51.100.25",
            forwardedProto: "https");

        Assert.Equal(IPAddress.Parse("203.0.113.10"), result.RemoteAddress);
        Assert.Equal("http", result.Scheme);
        Assert.Equal("198.51.100.25", result.ForwardedFor);
        Assert.Equal("https", result.ForwardedProto);
    }

    [Fact]
    public async Task Middleware_AppliesForwardedIdentityOnlyForConfiguredProxy()
    {
        var options = Build(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10"
        });

        var result = await ExecuteAsync(
            options,
            remoteAddress: "203.0.113.10",
            forwardedFor: "198.51.100.25",
            forwardedProto: "https");

        Assert.Equal(IPAddress.Parse("198.51.100.25"), result.RemoteAddress);
        Assert.Equal("https", result.Scheme);
        Assert.True(string.IsNullOrEmpty(result.ForwardedFor));
        Assert.True(string.IsNullOrEmpty(result.ForwardedProto));
    }

    [Fact]
    public async Task Middleware_ForwardLimitConsumesOnlyNearestConfiguredHop()
    {
        var platformOptions = new ApiPlatformOptions.ForwardedHeaderOptions
        {
            Enabled = true,
            ForwardLimit = 1
        };
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["Platform:ForwardedHeaders:KnownProxies:0"] = "203.0.113.10"
        });
        var options = ForwardedHeaderTrustPolicy.Build(platformOptions, configuration);

        var result = await ExecuteAsync(
            options,
            remoteAddress: "203.0.113.10",
            forwardedFor: "198.51.100.20, 198.51.100.21",
            forwardedProto: "http, https");

        Assert.Equal(IPAddress.Parse("198.51.100.21"), result.RemoteAddress);
        Assert.Equal("https", result.Scheme);
        Assert.Equal("198.51.100.20", result.ForwardedFor);
        Assert.Equal("http", result.ForwardedProto);
    }

    [Fact]
    public void Build_UsesOnlyForAndProtoForwarders()
    {
        var result = Build();

        Assert.Equal(
            Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor |
            Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto,
            result.ForwardedHeaders);
    }

    [Fact]
    public void Build_ThrowsForNullInputs()
    {
        Assert.Throws<ArgumentNullException>(() => ForwardedHeaderTrustPolicy.Build(null!, BuildConfiguration(null)));
        Assert.Throws<ArgumentNullException>(() => ForwardedHeaderTrustPolicy.Build(new ApiPlatformOptions.ForwardedHeaderOptions(), null!));
    }

    private static Microsoft.AspNetCore.Builder.ForwardedHeadersOptions Build(
        IDictionary<string, string?>? values = null)
    {
        return ForwardedHeaderTrustPolicy.Build(
            new ApiPlatformOptions.ForwardedHeaderOptions
            {
                Enabled = true,
                ForwardLimit = 1
            },
            BuildConfiguration(values));
    }

    private static IConfiguration BuildConfiguration(IDictionary<string, string?>? values)
    {
        var builder = new ConfigurationBuilder();
        if (values != null)
        {
            builder.AddInMemoryCollection(values);
        }

        return builder.Build();
    }

    private static async Task<ObservedRequest> ExecuteAsync(
        Microsoft.AspNetCore.Builder.ForwardedHeadersOptions options,
        string remoteAddress,
        string forwardedFor,
        string forwardedProto)
    {
        using var services = new ServiceCollection()
            .AddLogging()
            .BuildServiceProvider();

        var app = new ApplicationBuilder(services);
        IPAddress? observedAddress = null;
        string? observedScheme = null;
        string? observedFor = null;
        string? observedProto = null;

        app.UseForwardedHeaders(options);
        app.Run(context =>
        {
            observedAddress = context.Connection.RemoteIpAddress;
            observedScheme = context.Request.Scheme;
            observedFor = context.Request.Headers["X-Forwarded-For"].ToString();
            observedProto = context.Request.Headers["X-Forwarded-Proto"].ToString();
            return Task.CompletedTask;
        });

        var pipeline = app.Build();
        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        context.Connection.RemoteIpAddress = IPAddress.Parse(remoteAddress);
        context.Request.Scheme = "http";
        context.Request.Headers["X-Forwarded-For"] = forwardedFor;
        context.Request.Headers["X-Forwarded-Proto"] = forwardedProto;

        await pipeline(context);

        return new ObservedRequest(
            observedAddress,
            observedScheme ?? string.Empty,
            observedFor ?? string.Empty,
            observedProto ?? string.Empty);
    }

    private sealed record ObservedRequest(
        IPAddress? RemoteAddress,
        string Scheme,
        string ForwardedFor,
        string ForwardedProto);
}
