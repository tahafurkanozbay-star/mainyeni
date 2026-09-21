using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestGovernanceOptionsTests
{
    private readonly ApiPlatformOptionsValidator validator = new ApiPlatformOptionsValidator();

    [Fact]
    public void Defaults_AreEnabledAndBounded()
    {
        var options = new ApiPlatformOptions();

        Assert.True(options.Governance.Enabled);
        Assert.Equal(12288, options.Governance.MaxRawTargetChars);
        Assert.Equal(2048, options.Governance.MaxPathChars);
        Assert.Equal(6144, options.Governance.MaxQueryStringChars);
        Assert.Equal(128, options.Governance.MaxQueryParameters);
        Assert.Equal(64, options.Governance.MaxHeaderCount);
        Assert.Equal(32768, options.Governance.MaxHeaderBytes);
        Assert.True(options.Governance.RejectTraceAndConnect);
        Assert.True(options.Governance.RejectPathTraversal);
        Assert.True(options.Governance.RejectEncodedPathSeparators);
        Assert.True(options.Governance.RequireKnownContentTypeForBodyRequests);
        Assert.True(options.Governance.Concurrency.Enabled);
        Assert.Equal(512, options.Governance.Concurrency.MaxConcurrentRequests);
        Assert.Equal(32, options.Governance.Concurrency.MaxConcurrentPerClient);
    }

    [Fact]
    public void Defaults_PassFailClosedValidator()
    {
        var result = validator.Validate(null!, new ApiPlatformOptions());

        Assert.True(result.Succeeded);
    }

    [Fact]
    public void MissingGovernanceSection_FailsClosed()
    {
        var options = new ApiPlatformOptions { Governance = null! };

        Assert.Contains(
            Failures(options),
            value => value.Contains("Governance configuration", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(255)]
    [InlineData(32769)]
    public void RawTargetBudget_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxRawTargetChars = value;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("MaxRawTargetChars", StringComparison.Ordinal));
    }

    [Fact]
    public void PathAndQueryCombinedBudget_CannotExceedRawTargetBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxRawTargetChars = 1000;
        options.Governance.MaxPathChars = 600;
        options.Governance.MaxQueryStringChars = 600;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("path/query budgets", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1025)]
    public void QueryParameterBudget_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxQueryParameters = value;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("MaxQueryParameters", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(7)]
    [InlineData(257)]
    public void HeaderCountBudget_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderCount = value;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("MaxHeaderCount", StringComparison.Ordinal));
    }

    [Fact]
    public void PerHeaderBudget_CannotExceedTotalHeaderBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 4096;
        options.Governance.MaxAuthorizationHeaderBytes = 5000;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("MaxAuthorizationHeaderBytes", StringComparison.Ordinal));
    }

    [Fact]
    public void MissingAllowedBodyContentTypes_FailsClosed()
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes = new List<string>();

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("AllowedBodyContentTypes", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("")]
    [InlineData("applicationjson")]
    [InlineData("application/json\r\nX-Test: injected")]
    public void InvalidAllowedMediaType_FailsClosed(string value)
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes = new List<string> { value };

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("Invalid request media type", StringComparison.Ordinal));
    }

    [Fact]
    public void MissingConcurrencySection_FailsClosed()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency = null!;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("Concurrency configuration", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(100001)]
    public void GlobalConcurrency_RejectsUnsafeBounds(int value)
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = value;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("MaxConcurrentRequests", StringComparison.Ordinal));
    }

    [Fact]
    public void PerClientConcurrency_CannotExceedGlobalLimit()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.MaxConcurrentRequests = 10;
        options.Governance.Concurrency.MaxConcurrentPerClient = 11;

        Assert.Contains(
            Failures(options),
            failure => failure.Contains("MaxConcurrentPerClient", StringComparison.Ordinal));
    }

    [Fact]
    public void DisabledGovernance_DoesNotValidateInactiveBudgets()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        options.Governance.MaxRawTargetChars = 0;
        options.Governance.MaxHeaderBytes = 0;
        options.Governance.Concurrency = null!;

        Assert.True(validator.Validate(null!, options).Succeeded);
    }

    [Fact]
    public void DisabledConcurrency_DoesNotValidateInactiveConcurrencyBudgets()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Concurrency.Enabled = false;
        options.Governance.Concurrency.MaxConcurrentRequests = 0;
        options.Governance.Concurrency.MaxConcurrentPerClient = 0;
        options.Governance.Concurrency.MaxTrackedClients = 0;

        Assert.True(validator.Validate(null!, options).Succeeded);
    }

    [Fact]
    public void Resolver_BindsGovernanceAndConcurrencyConfiguration()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Platform:Governance:MaxRawTargetChars"] = "16000",
                ["Platform:Governance:MaxPathChars"] = "3000",
                ["Platform:Governance:MaxQueryStringChars"] = "6000",
                ["Platform:Governance:MaxQueryParameters"] = "200",
                ["Platform:Governance:MaxHeaderCount"] = "80",
                ["Platform:Governance:Concurrency:MaxConcurrentRequests"] = "900",
                ["Platform:Governance:Concurrency:MaxConcurrentPerClient"] = "45",
                ["Platform:Governance:Concurrency:MaxTrackedClients"] = "5000",
                ["Platform:Governance:Concurrency:RetryAfterSeconds"] = "2",
                ["Platform:Governance:AllowedBodyContentTypes:0"] = "application/json",
                ["Platform:Governance:AllowedBodyContentTypes:1"] = "application/vnd.test+json"
            })
            .Build();

        var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

        Assert.Equal(16000, options.Governance.MaxRawTargetChars);
        Assert.Equal(3000, options.Governance.MaxPathChars);
        Assert.Equal(6000, options.Governance.MaxQueryStringChars);
        Assert.Equal(200, options.Governance.MaxQueryParameters);
        Assert.Equal(80, options.Governance.MaxHeaderCount);
        Assert.Equal(900, options.Governance.Concurrency.MaxConcurrentRequests);
        Assert.Equal(45, options.Governance.Concurrency.MaxConcurrentPerClient);
        Assert.Equal(5000, options.Governance.Concurrency.MaxTrackedClients);
        Assert.Equal(2, options.Governance.Concurrency.RetryAfterSeconds);
        Assert.Contains("application/vnd.test+json", options.Governance.AllowedBodyContentTypes);
    }

    [Fact]
    public void AppSettingsExposeGovernanceWithoutSecrets()
    {
        var user = System.IO.File.ReadAllText(
            System.IO.Path.Combine(RepositoryRoot(), "Api.User", "appsettings.json"));
        var admin = System.IO.File.ReadAllText(
            System.IO.Path.Combine(RepositoryRoot(), "Api.Admin", "appsettings.json"));

        Assert.Contains("\"Governance\"", user, StringComparison.Ordinal);
        Assert.Contains("\"Governance\"", admin, StringComparison.Ordinal);
        Assert.DoesNotContain("Password=", user, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Password=", admin, StringComparison.OrdinalIgnoreCase);
    }

    private IReadOnlyList<string> Failures(ApiPlatformOptions options)
    {
        var result = validator.Validate(null!, options);
        Assert.False(result.Succeeded);
        return result.Failures?.ToArray() ?? Array.Empty<string>();
    }

    private static string RepositoryRoot()
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (System.IO.File.Exists(
                System.IO.Path.Combine(directory.FullName, "KENT_REHBERI_AGENT_RULES.md")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }

        throw new System.IO.DirectoryNotFoundException("Repository root not found.");
    }
}
