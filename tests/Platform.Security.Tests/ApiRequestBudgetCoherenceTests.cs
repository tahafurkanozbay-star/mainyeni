using Api.Core.Platform;
using Api.Core.Platform.Transport;
using Microsoft.Extensions.Options;
using System;
using System.IO;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiRequestBudgetCoherenceTests
{
    [Fact]
    public void Validate_DefaultBudgets_AreCoherent()
    {
        var failures = ApiRequestBudgetCoherence.Validate(new ApiPlatformOptions());

        Assert.Empty(failures);
    }

    [Fact]
    public void Validate_TransportBodyBelowApplicationGuard_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestBodyBytes = options.Requests.MaxRequestBodyBytes - 1;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.Contains(
            failures,
            failure => failure.Contains("MaxRequestBodyBytes", StringComparison.Ordinal) &&
                       failure.Contains("application request guard", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Validate_EqualTransportAndApplicationBodyBudgets_Succeeds()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestBodyBytes = 2L * 1024 * 1024;
        options.Requests.MaxRequestBodyBytes = 2L * 1024 * 1024;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.DoesNotContain(
            failures,
            failure => failure.Contains("MaxRequestBodyBytes", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_TransportHeaderBytesBelowGovernanceCeiling_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestHeadersTotalSizeBytes = (int)options.Governance.MaxHeaderBytes - 1;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.Contains(
            failures,
            failure => failure.Contains("MaxRequestHeadersTotalSizeBytes", StringComparison.Ordinal) &&
                       failure.Contains("MaxHeaderBytes", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_EqualTransportAndGovernanceHeaderByteBudgets_Succeeds()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestHeadersTotalSizeBytes = 24000;
        options.Governance.MaxHeaderBytes = 24000;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.DoesNotContain(
            failures,
            failure => failure.Contains("MaxRequestHeadersTotalSizeBytes", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_TransportHeaderCountBelowGovernanceCeiling_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestHeaderCount = options.Governance.MaxHeaderCount - 1;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.Contains(
            failures,
            failure => failure.Contains("MaxRequestHeaderCount", StringComparison.Ordinal) &&
                       failure.Contains("MaxHeaderCount", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_EqualTransportAndGovernanceHeaderCountBudgets_Succeeds()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestHeaderCount = 48;
        options.Governance.MaxHeaderCount = 48;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.DoesNotContain(
            failures,
            failure => failure.Contains("MaxRequestHeaderCount", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_DisabledGovernance_DoesNotCoupleHeaderBudgets()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        options.Transport.MaxRequestHeadersTotalSizeBytes = 8192;
        options.Transport.MaxRequestHeaderCount = 16;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.DoesNotContain(
            failures,
            failure => failure.Contains("MaxRequestHeadersTotalSizeBytes", StringComparison.Ordinal) ||
                       failure.Contains("MaxRequestHeaderCount", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_DisabledGovernance_StillProtectsApplicationBodyContract()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        options.Transport.MaxRequestBodyBytes = 1024;
        options.Requests.MaxRequestBodyBytes = 2048;

        var failures = ApiRequestBudgetCoherence.Validate(options);

        Assert.Contains(
            failures,
            failure => failure.Contains("MaxRequestBodyBytes", StringComparison.Ordinal));
    }

    [Fact]
    public void EnsureValid_IncoherentBudgets_ThrowsOptionsValidationException()
    {
        var options = new ApiPlatformOptions();
        options.Transport.MaxRequestBodyBytes = options.Requests.MaxRequestBodyBytes - 1;
        options.Transport.MaxRequestHeadersTotalSizeBytes = (int)options.Governance.MaxHeaderBytes - 1;
        options.Transport.MaxRequestHeaderCount = options.Governance.MaxHeaderCount - 1;

        var exception = Assert.Throws<OptionsValidationException>(() =>
            ApiRequestBudgetCoherence.EnsureValid(options));
        var failures = exception.Failures.ToArray();

        Assert.Equal(3, failures.Length);
        Assert.Contains(failures, failure => failure.Contains("MaxRequestBodyBytes", StringComparison.Ordinal));
        Assert.Contains(failures, failure => failure.Contains("MaxRequestHeadersTotalSizeBytes", StringComparison.Ordinal));
        Assert.Contains(failures, failure => failure.Contains("MaxRequestHeaderCount", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_NullOptions_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ApiRequestBudgetCoherence.Validate(null!));
    }

    [Fact]
    public void TransportStartup_InvokesBudgetCoherenceBeforeKestrelConfiguration()
    {
        var source = File.ReadAllText(Path.Combine(
            RepositoryRoot(),
            "Api.Core",
            "Platform",
            "Transport",
            "ApiTransportPolicy.cs"));

        var coherenceIndex = source.IndexOf(
            "ApiRequestBudgetCoherence.EnsureValid(platformOptions)",
            StringComparison.Ordinal);
        var kestrelIndex = source.IndexOf(
            "return webHost.ConfigureKestrel",
            StringComparison.Ordinal);

        Assert.True(coherenceIndex >= 0, "Transport startup must validate cross-layer request budgets.");
        Assert.True(kestrelIndex > coherenceIndex, "Budget coherence must be validated before Kestrel is configured.");
    }

    [Fact]
    public void CoherencePolicy_DoesNotPretendCharacterAndByteBudgetsAreEquivalent()
    {
        var source = File.ReadAllText(Path.Combine(
            RepositoryRoot(),
            "Api.Core",
            "Platform",
            "Transport",
            "ApiRequestBudgetCoherence.cs"));

        Assert.Contains("MaxRequestLineSize is byte-based", source, StringComparison.Ordinal);
        Assert.Contains("MaxRawTargetChars is a", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MaxRawTargetChars +", source, StringComparison.Ordinal);
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
