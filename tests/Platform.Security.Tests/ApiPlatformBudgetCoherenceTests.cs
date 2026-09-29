using Api.Core.Platform;
using Microsoft.Extensions.Options;
using System;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiPlatformBudgetCoherenceTests
{
    private readonly ApiPlatformOptionsValidator validator = new();

    [Fact]
    public void Validate_DefaultBudgets_AreCoherent()
    {
        Assert.True(Validate(new ApiPlatformOptions()).Succeeded);
    }

    [Fact]
    public void Validate_TransportBodyBelowApplicationBody_FailsClosed()
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxRequestBodyBytes = 2L * 1024 * 1024;
        options.Transport.MaxRequestBodyBytes = 1024 * 1024;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "Transport:MaxRequestBodyBytes");
        AssertContainsFailure(result, "Requests:MaxRequestBodyBytes");
    }

    [Fact]
    public void Validate_TransportHeaderCountBelowGovernanceBudget_FailsClosed()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderCount = 64;
        options.Transport.MaxRequestHeaderCount = 63;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "Transport:MaxRequestHeaderCount");
        AssertContainsFailure(result, "Governance:MaxHeaderCount");
    }

    [Fact]
    public void Validate_TransportHeaderBytesBelowGovernanceBudget_FailsClosed()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 32768;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 32767;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "Transport:MaxRequestHeadersTotalSizeBytes");
        AssertContainsFailure(result, "Governance:MaxHeaderBytes");
    }

    [Fact]
    public void Validate_EqualCrossLayerBudgets_Succeed()
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxRequestBodyBytes = 4L * 1024 * 1024;
        options.Transport.MaxRequestBodyBytes = 4L * 1024 * 1024;
        options.Governance.MaxHeaderCount = 48;
        options.Transport.MaxRequestHeaderCount = 48;
        options.Governance.MaxHeaderBytes = 24576;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 24576;

        Assert.True(Validate(options).Succeeded);
    }

    [Fact]
    public void Validate_DisabledGovernance_DoesNotImposeMetadataBudgets()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        options.Transport.MaxRequestHeaderCount = 16;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 8192;

        Assert.True(Validate(options).Succeeded);
    }

    [Fact]
    public void Validate_DisabledGovernance_StillRequiresTransportBodyToCoverApplicationBody()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        options.Requests.MaxRequestBodyBytes = 2L * 1024 * 1024;
        options.Transport.MaxRequestBodyBytes = 1024 * 1024;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "Transport:MaxRequestBodyBytes");
    }

    private ValidateOptionsResult Validate(ApiPlatformOptions options)
    {
        return validator.Validate(Options.DefaultName, options);
    }

    private static void AssertContainsFailure(ValidateOptionsResult result, string fragment)
    {
        var failures = result.Failures?.ToArray() ?? Array.Empty<string>();
        Assert.Contains(
            failures,
            value => value.Contains(fragment, StringComparison.OrdinalIgnoreCase));
    }
}
