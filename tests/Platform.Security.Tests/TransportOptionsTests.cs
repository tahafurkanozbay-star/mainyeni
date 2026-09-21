using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class TransportOptionsTests
{
    private readonly ApiPlatformOptionsValidator validator = new ApiPlatformOptionsValidator();

    [Fact]
    public void Defaults_AreBoundedAndPassValidation()
    {
        var options = new ApiPlatformOptions();

        Assert.Equal(90, options.Transport.KeepAliveTimeoutSeconds);
        Assert.Equal(15, options.Transport.RequestHeadersTimeoutSeconds);
        Assert.Equal(16384, options.Transport.MaxRequestLineSizeBytes);
        Assert.Equal(32768, options.Transport.MaxRequestHeadersTotalSizeBytes);
        Assert.Equal(64, options.Transport.MaxRequestHeaderCount);
        Assert.Equal(10L * 1024 * 1024, options.Transport.MaxRequestBodyBytes);
        Assert.True(validator.Validate(null!, options).Succeeded);
    }

    [Fact]
    public void MissingTransportSection_FailsClosed()
    {
        var options = new ApiPlatformOptions { Transport = null! };

        Assert.Contains(
            Failures(options),
            value => value.Contains("Platform:Transport configuration", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(4)]
    [InlineData(301)]
    public void KeepAliveTimeout_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Transport.KeepAliveTimeoutSeconds = value;

        Assert.Contains(
            Failures(options),
            value => value.Contains("KeepAliveTimeoutSeconds", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(121)]
    public void RequestHeadersTimeout_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Transport.RequestHeadersTimeoutSeconds = value;

        Assert.Contains(
            Failures(options),
            value => value.Contains("RequestHeadersTimeoutSeconds", StringComparison.Ordinal));
    }

    [Fact]
    public void RequestHeadersTimeout_MustBeLowerThanKeepAliveTimeout()
    {
        var options = new ApiPlatformOptions();
        options.Transport.KeepAliveTimeoutSeconds = 30;
        options.Transport.RequestHeadersTimeoutSeconds = 30;

        Assert.Contains(
            Failures(options),
            value => value.Contains("must be lower", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(4095)]
    [InlineData(32769)]
    public void RequestLineBudget_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestLineSizeBytes = value;

        Assert.Contains(
            Failures(options),
            value => value.Contains("MaxRequestLineSizeBytes", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(8191)]
    [InlineData(131073)]
    public void HeaderByteBudget_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestHeadersTotalSizeBytes = value;

        Assert.Contains(
            Failures(options),
            value => value.Contains("MaxRequestHeadersTotalSizeBytes", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(15)]
    [InlineData(257)]
    public void HeaderCountBudget_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestHeaderCount = value;

        Assert.Contains(
            Failures(options),
            value => value.Contains("MaxRequestHeaderCount", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(1023)]
    [InlineData(104857601)]
    public void BodyBudget_RejectsUnsafeBounds(long value)
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestBodyBytes = value;

        Assert.Contains(
            Failures(options),
            item => item.Contains("MaxRequestBodyBytes", StringComparison.Ordinal));
    }

    [Fact]
    public void Resolver_BindsTransportConfiguration()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Platform:Transport:KeepAliveTimeoutSeconds"] = "120",
                ["Platform:Transport:RequestHeadersTimeoutSeconds"] = "20",
                ["Platform:Transport:MaxRequestLineSizeBytes"] = "20000",
                ["Platform:Transport:MaxRequestHeadersTotalSizeBytes"] = "64000",
                ["Platform:Transport:MaxRequestHeaderCount"] = "80",
                ["Platform:Transport:MaxRequestBodyBytes"] = "5242880"
            })
            .Build();

        var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

        Assert.Equal(120, options.Transport.KeepAliveTimeoutSeconds);
        Assert.Equal(20, options.Transport.RequestHeadersTimeoutSeconds);
        Assert.Equal(20000, options.Transport.MaxRequestLineSizeBytes);
        Assert.Equal(64000, options.Transport.MaxRequestHeadersTotalSizeBytes);
        Assert.Equal(80, options.Transport.MaxRequestHeaderCount);
        Assert.Equal(5242880, options.Transport.MaxRequestBodyBytes);
        Assert.True(validator.Validate(null!, options).Succeeded);
    }

    [Fact]
    public void LowerSafeBounds_AreAccepted()
    {
        var options = new ApiPlatformOptions();
        options.Transport.KeepAliveTimeoutSeconds = 5;
        options.Transport.RequestHeadersTimeoutSeconds = 2;
        options.Transport.MaxRequestLineSizeBytes = 4096;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 8192;
        options.Transport.MaxRequestHeaderCount = 16;
        options.Transport.MaxRequestBodyBytes = 1024;

        Assert.True(validator.Validate(null!, options).Succeeded);
    }

    [Fact]
    public void UpperSafeBounds_AreAcceptedWhenTimeoutOrderingIsValid()
    {
        var options = new ApiPlatformOptions();
        options.Transport.KeepAliveTimeoutSeconds = 300;
        options.Transport.RequestHeadersTimeoutSeconds = 120;
        options.Transport.MaxRequestLineSizeBytes = 32768;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 131072;
        options.Transport.MaxRequestHeaderCount = 256;
        options.Transport.MaxRequestBodyBytes = 100L * 1024 * 1024;

        Assert.True(validator.Validate(null!, options).Succeeded);
    }

    [Fact]
    public void MultipleTransportFailures_AreReportedTogether()
    {
        var options = new ApiPlatformOptions();
        options.Transport.KeepAliveTimeoutSeconds = 1;
        options.Transport.RequestHeadersTimeoutSeconds = 500;
        options.Transport.MaxRequestLineSizeBytes = 1;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 1;
        options.Transport.MaxRequestHeaderCount = 1;
        options.Transport.MaxRequestBodyBytes = 1;

        var failures = Failures(options);

        Assert.True(failures.Count >= 6);
        Assert.Contains(failures, value => value.Contains("KeepAliveTimeoutSeconds", StringComparison.Ordinal));
        Assert.Contains(failures, value => value.Contains("RequestHeadersTimeoutSeconds", StringComparison.Ordinal));
        Assert.Contains(failures, value => value.Contains("MaxRequestLineSizeBytes", StringComparison.Ordinal));
        Assert.Contains(failures, value => value.Contains("MaxRequestHeadersTotalSizeBytes", StringComparison.Ordinal));
        Assert.Contains(failures, value => value.Contains("MaxRequestHeaderCount", StringComparison.Ordinal));
        Assert.Contains(failures, value => value.Contains("MaxRequestBodyBytes", StringComparison.Ordinal));
    }

    private IReadOnlyList<string> Failures(ApiPlatformOptions options)
    {
        var result = validator.Validate(null!, options);
        Assert.False(result.Succeeded);
        return result.Failures?.ToArray() ?? Array.Empty<string>();
    }
}
