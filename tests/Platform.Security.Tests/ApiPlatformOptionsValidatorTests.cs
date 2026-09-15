using Api.Core.Platform;
using Microsoft.Extensions.Options;
using System;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiPlatformOptionsValidatorTests
{
    private readonly ApiPlatformOptionsValidator _validator = new();

    [Fact]
    public void Validate_DefaultOptions_AreValid()
    {
        var result = Validate(new ApiPlatformOptions());

        Assert.True(result.Succeeded);
    }

    [Fact]
    public void Validate_NullOptions_Fails()
    {
        var result = _validator.Validate(Options.DefaultName, null!);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "required");
    }

    [Theory]
    [InlineData("MYSQL")]
    [InlineData("MSSQL")]
    [InlineData("SQLITE")]
    [InlineData("oracle")]
    public void Validate_UnsupportedDatabaseProvider_Fails(string provider)
    {
        var options = new ApiPlatformOptions();
        options.Database.Provider = provider;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "Provider");
    }

    [Theory]
    [InlineData("PGSQL")]
    [InlineData("pgsql")]
    [InlineData(" pgsql ")]
    public void Validate_PostgreSqlProvider_Succeeds(string provider)
    {
        var options = new ApiPlatformOptions();
        options.Database.Provider = provider;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(301)]
    [InlineData(5000)]
    public void Validate_InvalidDatabaseCommandTimeout_Fails(int timeout)
    {
        var options = new ApiPlatformOptions();
        options.Database.CommandTimeoutSeconds = timeout;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "CommandTimeoutSeconds");
    }

    [Theory]
    [InlineData(1)]
    [InlineData(30)]
    [InlineData(300)]
    public void Validate_ValidDatabaseCommandTimeout_Succeeds(int timeout)
    {
        var options = new ApiPlatformOptions();
        options.Database.CommandTimeoutSeconds = timeout;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(11)]
    [InlineData(100)]
    public void Validate_InvalidDatabaseRetryCount_Fails(int count)
    {
        var options = new ApiPlatformOptions();
        options.Database.RetryCount = count;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "RetryCount");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10)]
    public void Validate_ValidDatabaseRetryCount_Succeeds(int count)
    {
        var options = new ApiPlatformOptions();
        options.Database.RetryCount = count;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(61)]
    [InlineData(1000)]
    public void Validate_InvalidDatabaseRetryDelay_Fails(int seconds)
    {
        var options = new ApiPlatformOptions();
        options.Database.RetryMaxDelaySeconds = seconds;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "RetryMaxDelaySeconds");
    }

    [Theory]
    [InlineData("*")]
    [InlineData("ftp://example.test")]
    [InlineData("example.test")]
    [InlineData("/relative")]
    [InlineData("https://example.test/path")]
    [InlineData("https://example.test/?query=1")]
    [InlineData("https://example.test/#fragment")]
    public void Validate_InvalidCorsOrigin_Fails(string origin)
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedOrigins.Add(origin);

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "origin");
    }

    [Theory]
    [InlineData("https://example.test")]
    [InlineData("http://localhost:3000")]
    [InlineData("https://127.0.0.1:5001")]
    public void Validate_ValidCorsOrigin_Succeeds(string origin)
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedOrigins.Add(origin);

        Assert.True(Validate(options).Succeeded);
    }

    [Fact]
    public void Validate_BlankCorsOrigin_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedOrigins.Add("  ");

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "blank");
    }

    [Fact]
    public void Validate_NoCorsMethods_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedMethods.Clear();

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "AllowedMethods");
    }

    [Theory]
    [InlineData("TRACE")]
    [InlineData("CONNECT")]
    [InlineData("")]
    [InlineData("CUSTOM")]
    public void Validate_UnsupportedCorsMethod_Fails(string method)
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedMethods.Add(method);

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "method");
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("post")]
    [InlineData("HEAD")]
    [InlineData("OPTIONS")]
    public void Validate_SupportedCorsMethod_Succeeds(string method)
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedMethods.Clear();
        options.Cors.AllowedMethods.Add(method);

        Assert.True(Validate(options).Succeeded);
    }

    [Fact]
    public void Validate_NoCorsHeaders_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedHeaders.Clear();

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "AllowedHeaders");
    }

    [Fact]
    public void Validate_BlankCorsHeader_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Cors.AllowedHeaders.Add(" ");

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "AllowedHeaders");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(301)]
    public void Validate_InvalidRequestTimeout_Fails(int seconds)
    {
        var options = new ApiPlatformOptions();
        options.Requests.TimeoutSeconds = seconds;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "TimeoutSeconds");
    }

    [Theory]
    [InlineData(1)]
    [InlineData(30)]
    [InlineData(300)]
    public void Validate_ValidRequestTimeout_Succeeds(int seconds)
    {
        var options = new ApiPlatformOptions();
        options.Requests.TimeoutSeconds = seconds;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1023)]
    [InlineData(104857601)]
    public void Validate_InvalidRequestBodyLimit_Fails(long bytes)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxRequestBodyBytes = bytes;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "MaxRequestBodyBytes");
    }

    [Theory]
    [InlineData(1024)]
    [InlineData(1048576)]
    [InlineData(104857600)]
    public void Validate_ValidRequestBodyLimit_Succeeds(long bytes)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxRequestBodyBytes = bytes;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(15)]
    [InlineData(257)]
    public void Validate_InvalidCorrelationLength_Fails(int length)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxCorrelationIdLength = length;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "MaxCorrelationIdLength");
    }

    [Theory]
    [InlineData(16)]
    [InlineData(96)]
    [InlineData(256)]
    public void Validate_ValidCorrelationLength_Succeeds(int length)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxCorrelationIdLength = length;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("X Request")]
    [InlineData("X_Request")]
    [InlineData("X@Request")]
    public void Validate_InvalidCorrelationHeaderName_Fails(string header)
    {
        var options = new ApiPlatformOptions();
        options.Requests.CorrelationHeaderName = header;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "CorrelationHeaderName");
    }

    [Theory]
    [InlineData("X-Correlation-ID")]
    [InlineData("X-Request-ID")]
    [InlineData("Traceparent")]
    public void Validate_ValidCorrelationHeaderName_Succeeds(string header)
    {
        var options = new ApiPlatformOptions();
        options.Requests.CorrelationHeaderName = header;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(63072001)]
    public void Validate_InvalidHstsMaxAge_Fails(int seconds)
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.HstsMaxAgeSeconds = seconds;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "HstsMaxAgeSeconds");
    }

    [Fact]
    public void Validate_DisabledSecurityHeaders_DoNotRequireHeaderValues()
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.Enabled = false;
        options.SecurityHeaders.FrameOptions = string.Empty;
        options.SecurityHeaders.ReferrerPolicy = string.Empty;
        options.SecurityHeaders.PermissionsPolicy = string.Empty;
        options.SecurityHeaders.CrossOriginResourcePolicy = string.Empty;
        options.SecurityHeaders.CrossOriginOpenerPolicy = string.Empty;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData("DENY\r\nX-Injection: yes")]
    [InlineData("DENY\nX-Injection: yes")]
    public void Validate_HeaderNewlineInjection_Fails(string header)
    {
        var options = new ApiPlatformOptions();
        options.SecurityHeaders.FrameOptions = header;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "FrameOptions");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(31)]
    public void Validate_InvalidDatabaseHealthTimeout_Fails(int seconds)
    {
        var options = new ApiPlatformOptions();
        options.Health.DatabaseTimeoutSeconds = seconds;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "DatabaseTimeoutSeconds");
    }

    [Theory]
    [InlineData("health/live")]
    [InlineData("/health/../secret")]
    [InlineData("/health/live?verbose=true")]
    [InlineData("/health/live#fragment")]
    [InlineData("/health\\live")]
    public void Validate_InvalidHealthPath_Fails(string path)
    {
        var options = new ApiPlatformOptions();
        options.Health.LivenessPath = path;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "LivenessPath");
    }

    [Fact]
    public void Validate_IdenticalHealthPaths_Fails()
    {
        var options = new ApiPlatformOptions();
        options.Health.LivenessPath = "/health/same";
        options.Health.ReadinessPath = "/health/same";

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "different");
    }

    [Fact]
    public void Validate_DisabledHealth_DoesNotRequirePaths()
    {
        var options = new ApiPlatformOptions();
        options.Health.Enabled = false;
        options.Health.LivenessPath = string.Empty;
        options.Health.ReadinessPath = string.Empty;
        options.Health.DatabaseTimeoutSeconds = 0;

        Assert.True(Validate(options).Succeeded);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    public void Validate_InvalidForwardLimit_Fails(int value)
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.ForwardLimit = value;

        var result = Validate(options);

        Assert.False(result.Succeeded);
        AssertContainsFailure(result, "ForwardLimit");
    }

    [Fact]
    public void Validate_DisabledForwardedHeaders_DoesNotRequirePositiveLimit()
    {
        var options = new ApiPlatformOptions();
        options.ForwardedHeaders.Enabled = false;
        options.ForwardedHeaders.ForwardLimit = 0;

        Assert.True(Validate(options).Succeeded);
    }

    [Fact]
    public void Validate_ReportsMultipleFailuresTogether()
    {
        var options = new ApiPlatformOptions();
        options.Database.Provider = "MYSQL";
        options.Database.CommandTimeoutSeconds = 0;
        options.Requests.TimeoutSeconds = 0;
        options.Cors.AllowedOrigins.Add("*");
        options.Health.ReadinessPath = options.Health.LivenessPath;

        var result = Validate(options);
        var failures = result.Failures?.ToArray() ?? Array.Empty<string>();

        Assert.False(result.Succeeded);
        Assert.True(failures.Length >= 5);
        Assert.Contains(failures, value => value.Contains("Provider", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(failures, value => value.Contains("CommandTimeoutSeconds", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(failures, value => value.Contains("TimeoutSeconds", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(failures, value => value.Contains("origin", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(failures, value => value.Contains("different", StringComparison.OrdinalIgnoreCase));
    }

    private ValidateOptionsResult Validate(ApiPlatformOptions options)
    {
        return _validator.Validate(Options.DefaultName, options);
    }

    private static void AssertContainsFailure(ValidateOptionsResult result, string fragment)
    {
        var failures = result.Failures?.ToArray() ?? Array.Empty<string>();
        Assert.Contains(failures, value => value.Contains(fragment, StringComparison.OrdinalIgnoreCase));
    }
}
