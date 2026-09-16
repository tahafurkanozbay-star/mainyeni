using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class PlatformResilienceOptionsTests
    {
        private readonly ApiPlatformOptionsValidator validator = new ApiPlatformOptionsValidator();

        [Fact]
        public void Defaults_EnableBoundedResilienceFeatures()
        {
            var options = new ApiPlatformOptions();

            Assert.True(options.RateLimiting.Enabled);
            Assert.Equal(240, options.RateLimiting.PermitLimit);
            Assert.Equal(60, options.RateLimiting.WindowSeconds);
            Assert.Equal(6, options.RateLimiting.SegmentsPerWindow);
            Assert.Equal(0, options.RateLimiting.QueueLimit);
            Assert.True(options.RateLimiting.ExemptOptionsRequests);
            Assert.True(options.RateLimiting.ExemptHealthChecks);
            Assert.True(options.RateLimiting.PartitionAuthenticatedUsers);
            Assert.True(options.ResponseCompression.Enabled);
            Assert.True(options.ResponseCompression.EnableForHttps);
            Assert.True(options.Diagnostics.Enabled);
            Assert.True(options.Diagnostics.ServerTimingHeader);
        }

        [Fact]
        public void DefaultOptions_PassValidation()
        {
            var result = validator.Validate(null!, new ApiPlatformOptions());

            Assert.True(result.Succeeded);
        }

        [Fact]
        public void MissingRateLimitOptions_FailClosed()
        {
            var options = new ApiPlatformOptions { RateLimiting = null! };

            var failures = Failures(options);

            Assert.Contains(failures, value => value.Contains("RateLimiting configuration", System.StringComparison.Ordinal));
        }

        [Fact]
        public void MissingCompressionOptions_FailClosed()
        {
            var options = new ApiPlatformOptions { ResponseCompression = null! };

            var failures = Failures(options);

            Assert.Contains(failures, value => value.Contains("ResponseCompression configuration", System.StringComparison.Ordinal));
        }

        [Fact]
        public void MissingDiagnosticsOptions_FailClosed()
        {
            var options = new ApiPlatformOptions { Diagnostics = null! };

            var failures = Failures(options);

            Assert.Contains(failures, value => value.Contains("Diagnostics configuration", System.StringComparison.Ordinal));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(10001)]
        public void PermitLimit_RejectsUnsafeBounds(int value)
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.PermitLimit = value;

            Assert.Contains(
                Failures(options),
                failure => failure.Contains("PermitLimit", System.StringComparison.Ordinal));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-10)]
        [InlineData(3601)]
        public void WindowSeconds_RejectsUnsafeBounds(int value)
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.WindowSeconds = value;

            Assert.Contains(
                Failures(options),
                failure => failure.Contains("WindowSeconds", System.StringComparison.Ordinal));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(61)]
        public void SegmentsPerWindow_RejectsUnsafeBounds(int value)
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.SegmentsPerWindow = value;

            Assert.Contains(
                Failures(options),
                failure => failure.Contains("SegmentsPerWindow", System.StringComparison.Ordinal));
        }

        [Fact]
        public void SegmentsPerWindow_CannotExceedWindowSeconds()
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.WindowSeconds = 5;
            options.RateLimiting.SegmentsPerWindow = 6;

            Assert.Contains(
                Failures(options),
                failure => failure.Contains("cannot exceed WindowSeconds", System.StringComparison.Ordinal));
        }

        [Theory]
        [InlineData(-1)]
        [InlineData(1001)]
        public void QueueLimit_RejectsUnsafeBounds(int value)
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.QueueLimit = value;

            Assert.Contains(
                Failures(options),
                failure => failure.Contains("QueueLimit", System.StringComparison.Ordinal));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(3601)]
        public void RetryAfterSeconds_RejectsUnsafeBounds(int value)
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.RetryAfterSeconds = value;

            Assert.Contains(
                Failures(options),
                failure => failure.Contains("RetryAfterSeconds", System.StringComparison.Ordinal));
        }

        [Fact]
        public void DisabledRateLimiter_DoesNotValidateInactiveNumericPolicy()
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.Enabled = false;
            options.RateLimiting.PermitLimit = 0;
            options.RateLimiting.WindowSeconds = 0;
            options.RateLimiting.SegmentsPerWindow = 0;
            options.RateLimiting.QueueLimit = -1;
            options.RateLimiting.RetryAfterSeconds = 0;

            var result = validator.Validate(null!, options);

            Assert.True(result.Succeeded);
        }

        [Fact]
        public void Resolver_BindsRateLimitingConfiguration()
        {
            var configuration = BuildConfiguration(new Dictionary<string, string?>
            {
                ["Platform:RateLimiting:Enabled"] = "true",
                ["Platform:RateLimiting:PermitLimit"] = "500",
                ["Platform:RateLimiting:WindowSeconds"] = "120",
                ["Platform:RateLimiting:SegmentsPerWindow"] = "12",
                ["Platform:RateLimiting:QueueLimit"] = "20",
                ["Platform:RateLimiting:ExemptOptionsRequests"] = "false",
                ["Platform:RateLimiting:ExemptHealthChecks"] = "false",
                ["Platform:RateLimiting:PartitionAuthenticatedUsers"] = "false",
                ["Platform:RateLimiting:RetryAfterSeconds"] = "3"
            });

            var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

            Assert.True(options.RateLimiting.Enabled);
            Assert.Equal(500, options.RateLimiting.PermitLimit);
            Assert.Equal(120, options.RateLimiting.WindowSeconds);
            Assert.Equal(12, options.RateLimiting.SegmentsPerWindow);
            Assert.Equal(20, options.RateLimiting.QueueLimit);
            Assert.False(options.RateLimiting.ExemptOptionsRequests);
            Assert.False(options.RateLimiting.ExemptHealthChecks);
            Assert.False(options.RateLimiting.PartitionAuthenticatedUsers);
            Assert.Equal(3, options.RateLimiting.RetryAfterSeconds);
        }

        [Fact]
        public void Resolver_BindsCompressionAndDiagnosticsConfiguration()
        {
            var configuration = BuildConfiguration(new Dictionary<string, string?>
            {
                ["Platform:ResponseCompression:Enabled"] = "false",
                ["Platform:ResponseCompression:EnableForHttps"] = "false",
                ["Platform:Diagnostics:Enabled"] = "false",
                ["Platform:Diagnostics:ServerTimingHeader"] = "false"
            });

            var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

            Assert.False(options.ResponseCompression.Enabled);
            Assert.False(options.ResponseCompression.EnableForHttps);
            Assert.False(options.Diagnostics.Enabled);
            Assert.False(options.Diagnostics.ServerTimingHeader);
        }

        [Fact]
        public void Resolver_UsesSafeDefaultsWhenNewSectionsAreAbsent()
        {
            var configuration = BuildConfiguration(new Dictionary<string, string?>());

            var options = ApiPlatformConfigurationResolver.ResolveOptions(configuration);

            Assert.True(options.RateLimiting.Enabled);
            Assert.Equal(240, options.RateLimiting.PermitLimit);
            Assert.True(options.ResponseCompression.Enabled);
            Assert.True(options.Diagnostics.Enabled);
        }

        [Fact]
        public void ValidUpperBounds_AreAccepted()
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.PermitLimit = 10000;
            options.RateLimiting.WindowSeconds = 3600;
            options.RateLimiting.SegmentsPerWindow = 60;
            options.RateLimiting.QueueLimit = 1000;
            options.RateLimiting.RetryAfterSeconds = 3600;

            var result = validator.Validate(null!, options);

            Assert.True(result.Succeeded);
        }

        [Fact]
        public void ValidLowerBounds_AreAccepted()
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.PermitLimit = 1;
            options.RateLimiting.WindowSeconds = 1;
            options.RateLimiting.SegmentsPerWindow = 1;
            options.RateLimiting.QueueLimit = 0;
            options.RateLimiting.RetryAfterSeconds = 1;

            var result = validator.Validate(null!, options);

            Assert.True(result.Succeeded);
        }

        [Fact]
        public void MultipleRateLimitErrors_AreReportedTogether()
        {
            var options = new ApiPlatformOptions();
            options.RateLimiting.PermitLimit = 0;
            options.RateLimiting.WindowSeconds = 0;
            options.RateLimiting.SegmentsPerWindow = 0;
            options.RateLimiting.QueueLimit = -1;
            options.RateLimiting.RetryAfterSeconds = 0;

            var failures = Failures(options);

            Assert.True(failures.Count >= 5);
            Assert.Contains(failures, value => value.Contains("PermitLimit", System.StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("WindowSeconds", System.StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("SegmentsPerWindow", System.StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("QueueLimit", System.StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("RetryAfterSeconds", System.StringComparison.Ordinal));
        }

        private IReadOnlyList<string> Failures(ApiPlatformOptions options)
        {
            var result = validator.Validate(null!, options);
            Assert.False(result.Succeeded);
            return result.Failures?.ToArray() ?? System.Array.Empty<string>();
        }

        private static IConfiguration BuildConfiguration(
            IDictionary<string, string?> values)
        {
            return new ConfigurationBuilder()
                .AddInMemoryCollection(values)
                .Build();
        }
    }
}
