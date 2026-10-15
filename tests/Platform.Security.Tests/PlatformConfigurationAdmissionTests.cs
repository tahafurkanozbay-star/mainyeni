using System;
using System.Collections.Generic;
using System.Linq;
using Api.Core.Platform;
using Microsoft.Extensions.Options;
using Xunit;

namespace Platform.Security.Tests;

/// <summary>
/// Configuration is a trust boundary: malformed CORS field names and overly broad
/// body media allowlists must fail before either API begins serving requests.
/// </summary>
public sealed class PlatformConfigurationAdmissionTests
{
    private static IReadOnlyList<string> Failures(ApiPlatformOptions options)
    {
        var result = new ApiPlatformOptionsValidator().Validate(Options.DefaultName, options);
        Assert.False(result.Succeeded);
        return result.Failures?.ToArray() ?? Array.Empty<string>();
    }

    [Theory]
    [InlineData("X Bad")]
    [InlineData(" X-Good")]
    [InlineData("X-Good ")]
    [InlineData("X:Bad")]
    [InlineData("X@Bad")]
    [InlineData("X-Étrange")]
    [InlineData("X\r\nInjected: yes")]
    [InlineData("X\0Bad")]
    [InlineData("*")]
    public void Cors_allowlist_rejects_invalid_http_field_names(string header)
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedHeaders = new List<string> { header };
        Assert.Contains(Failures(options), failure =>
            failure.Contains("AllowedHeaders", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Authorization")]
    [InlineData("X_Request_ID")]
    [InlineData("X-Request-Id")]
    [InlineData("traceparent")]
    [InlineData("X-Feature+Flag")]
    public void Cors_allowlist_accepts_valid_http_field_name_tokens(string header)
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedHeaders = new List<string> { header };
        Assert.True(new ApiPlatformOptionsValidator().Validate(Options.DefaultName, options).Succeeded);
    }

    [Fact]
    public void Cors_allowlist_rejects_overlong_header_names()
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedHeaders = new List<string> { new string('X', 129) };
        Assert.Contains(Failures(options), failure =>
            failure.Contains("AllowedHeaders", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("applicationjson")]
    [InlineData("application//json")]
    [InlineData("application/jo son")]
    [InlineData("application/json; charset=utf-8")]
    [InlineData("*/json")]
    [InlineData("*/*")]
    [InlineData("application/*")]
    [InlineData("application/json\r\nX-Injected: yes")]
    [InlineData("application/x-*-json")]
    public void Body_media_allowlist_rejects_ambiguous_or_broad_patterns(string mediaType)
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes = new List<string> { mediaType };
        Assert.Contains(Failures(options), failure =>
            failure.Contains("Invalid request media type", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("application/geo+json")]
    [InlineData("application/*+json")]
    [InlineData("multipart/form-data")]
    [InlineData("application/x-www-form-urlencoded")]
    public void Body_media_allowlist_preserves_supported_explicit_patterns(string mediaType)
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes = new List<string> { mediaType };
        Assert.True(new ApiPlatformOptionsValidator().Validate(Options.DefaultName, options).Succeeded);
    }

    [Fact]
    public void Disabled_governance_does_not_validate_inactive_media_policy()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        options.Governance.AllowedBodyContentTypes = new List<string> { "bad media" };
        Assert.True(new ApiPlatformOptionsValidator().Validate(Options.DefaultName, options).Succeeded);
    }
}
