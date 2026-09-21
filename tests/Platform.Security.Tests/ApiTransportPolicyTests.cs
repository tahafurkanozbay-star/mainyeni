using Api.Core.Platform;
using Api.Core.Platform.Transport;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using System;
using System.IO;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiTransportPolicyTests
{
    [Fact]
    public void Apply_DisablesServerFingerprintAndSynchronousIo()
    {
        var server = new KestrelServerOptions
        {
            AddServerHeader = true,
            AllowSynchronousIO = true
        };

        ApiTransportPolicy.Apply(server, new ApiPlatformOptions.TransportOptions());

        Assert.False(server.AddServerHeader);
        Assert.False(server.AllowSynchronousIO);
    }

    [Fact]
    public void Apply_SetsExplicitKeepAliveAndHeaderTimeouts()
    {
        var server = new KestrelServerOptions();
        var options = new ApiPlatformOptions.TransportOptions
        {
            KeepAliveTimeoutSeconds = 75,
            RequestHeadersTimeoutSeconds = 11
        };

        ApiTransportPolicy.Apply(server, options);

        Assert.Equal(TimeSpan.FromSeconds(75), server.Limits.KeepAliveTimeout);
        Assert.Equal(TimeSpan.FromSeconds(11), server.Limits.RequestHeadersTimeout);
    }

    [Fact]
    public void Apply_SetsRequestLineAndHeaderBudgets()
    {
        var server = new KestrelServerOptions();
        var options = new ApiPlatformOptions.TransportOptions
        {
            MaxRequestLineSizeBytes = 12000,
            MaxRequestHeadersTotalSizeBytes = 24000,
            MaxRequestHeaderCount = 48
        };

        ApiTransportPolicy.Apply(server, options);

        Assert.Equal(12000, server.Limits.MaxRequestLineSize);
        Assert.Equal(24000, server.Limits.MaxRequestHeadersTotalSize);
        Assert.Equal(48, server.Limits.MaxRequestHeaderCount);
    }

    [Fact]
    public void Apply_SetsTransportBodyCeiling()
    {
        var server = new KestrelServerOptions();
        var options = new ApiPlatformOptions.TransportOptions
        {
            MaxRequestBodyBytes = 2 * 1024 * 1024
        };

        ApiTransportPolicy.Apply(server, options);

        Assert.Equal(2 * 1024 * 1024, server.Limits.MaxRequestBodySize);
    }

    [Fact]
    public void Apply_UsesDefaultRepositoryBudgetsDeterministically()
    {
        var server = new KestrelServerOptions();

        ApiTransportPolicy.Apply(server, new ApiPlatformOptions.TransportOptions());

        Assert.Equal(TimeSpan.FromSeconds(90), server.Limits.KeepAliveTimeout);
        Assert.Equal(TimeSpan.FromSeconds(15), server.Limits.RequestHeadersTimeout);
        Assert.Equal(16384, server.Limits.MaxRequestLineSize);
        Assert.Equal(32768, server.Limits.MaxRequestHeadersTotalSize);
        Assert.Equal(64, server.Limits.MaxRequestHeaderCount);
        Assert.Equal(10L * 1024 * 1024, server.Limits.MaxRequestBodySize);
    }

    [Fact]
    public void Apply_ThrowsForNullServerOptions()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ApiTransportPolicy.Apply(
                null!,
                new ApiPlatformOptions.TransportOptions()));
    }

    [Fact]
    public void Apply_ThrowsForNullPolicyOptions()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ApiTransportPolicy.Apply(
                new KestrelServerOptions(),
                null!));
    }

    [Theory]
    [InlineData("Api.User/Program.cs")]
    [InlineData("Api.Admin/Program.cs")]
    public void ApiHosts_ApplySharedTransportPolicy(string relativePath)
    {
        var text = File.ReadAllText(Path.Combine(
            RepositoryRoot(),
            relativePath.Replace('/', Path.DirectorySeparatorChar)));

        Assert.Contains("ConfigureKentRehberiTransport(builder.Configuration)", text, StringComparison.Ordinal);
        Assert.Contains("AddServerHeader = false", text, StringComparison.Ordinal);
        Assert.DoesNotContain("TimeSpan.FromMinutes(30)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void TransportPolicy_DoesNotIntroduceNetworkEndpoints()
    {
        var text = File.ReadAllText(Path.Combine(
            RepositoryRoot(),
            "Api.Core",
            "Platform",
            "Transport",
            "ApiTransportPolicy.cs"));

        Assert.DoesNotContain("http://", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("WMS", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("WFS", text, StringComparison.OrdinalIgnoreCase);
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "KENT_REHBERI_AGENT_RULES.md")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Repository root not found.");
    }
}
