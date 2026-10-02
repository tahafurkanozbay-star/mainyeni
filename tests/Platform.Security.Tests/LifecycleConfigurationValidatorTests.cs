using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Options;
using System;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class LifecycleConfigurationValidatorTests
    {
        [Fact]
        public void DefaultOptions_AreValid()
        {
            Assert.True(
                LifecycleConfigurationValidator
                    .Validate(new ApiPlatformOptions())
                    .Succeeded);
        }

        [Fact]
        public void NullOptions_FailClosed()
        {
            var result = LifecycleConfigurationValidator.Validate(null!);

            Assert.False(result.Succeeded);
            AssertContains(result, "required");
        }

        [Fact]
        public void MissingLifecycleOptions_FailClosed()
        {
            var options = new ApiPlatformOptions
            {
                Lifecycle = null!
            };

            var result = LifecycleConfigurationValidator.Validate(options);

            Assert.False(result.Succeeded);
            AssertContains(result, "Lifecycle");
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(301)]
        public void InvalidReadTimeout_Fails(int value)
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.ReadTimeoutSeconds = value;

            AssertInvalid(options, "ReadTimeoutSeconds");
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(301)]
        public void InvalidMutationTimeout_Fails(int value)
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.MutationTimeoutSeconds = value;

            AssertInvalid(options, "MutationTimeoutSeconds");
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(901)]
        public void InvalidBulkTimeout_Fails(int value)
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.BulkTimeoutSeconds = value;

            AssertInvalid(options, "BulkTimeoutSeconds");
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(31)]
        public void InvalidHealthTimeout_Fails(int value)
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.HealthTimeoutSeconds = value;

            AssertInvalid(options, "HealthTimeoutSeconds");
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(121)]
        public void InvalidShutdownDrainTimeout_Fails(int value)
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.ShutdownDrainSeconds = value;

            AssertInvalid(options, "ShutdownDrainSeconds");
        }

        [Fact]
        public void HealthTimeoutCannotExceedReadTimeout()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.ReadTimeoutSeconds = 4;
            options.Lifecycle.HealthTimeoutSeconds = 5;
            options.Health.DatabaseTimeoutSeconds = 3;

            AssertInvalid(options, "cannot exceed ReadTimeoutSeconds");
        }

        [Fact]
        public void DatabaseProbeMustFinishBeforeLifecycleHealthDeadline()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = true;
            options.Lifecycle.HealthTimeoutSeconds = 5;
            options.Health.DatabaseTimeoutSeconds = 5;

            AssertInvalid(options, "DatabaseTimeoutSeconds");
        }

        [Fact]
        public void DatabaseProbeMustFinishBeforeFrameworkFallbackDeadline()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = false;
            options.Requests.TimeoutSeconds = 3;
            options.Health.DatabaseTimeoutSeconds = 3;

            AssertInvalid(options, "DatabaseTimeoutSeconds");
        }

        [Fact]
        public void DisabledHealthDoesNotImposeDependencyProbeOrdering()
        {
            var options = new ApiPlatformOptions();
            options.Health.Enabled = false;
            options.Health.DatabaseTimeoutSeconds = 30;
            options.Lifecycle.HealthTimeoutSeconds = 1;

            var result = LifecycleConfigurationValidator.Validate(options);

            Assert.True(result.Succeeded);
        }

        [Fact]
        public void DependencyProbeBelowLifecycleDeadline_IsValid()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = true;
            options.Lifecycle.HealthTimeoutSeconds = 5;
            options.Health.DatabaseTimeoutSeconds = 4;

            Assert.True(LifecycleConfigurationValidator.Validate(options).Succeeded);
        }

        [Fact]
        public void DependencyProbeBelowFrameworkFallbackDeadline_IsValid()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = false;
            options.Requests.TimeoutSeconds = 30;
            options.Health.DatabaseTimeoutSeconds = 3;

            Assert.True(LifecycleConfigurationValidator.Validate(options).Succeeded);
        }

        [Fact]
        public void MultipleInvalidLifecycleValues_AreReportedTogether()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.ReadTimeoutSeconds = 0;
            options.Lifecycle.MutationTimeoutSeconds = 301;
            options.Lifecycle.BulkTimeoutSeconds = 901;
            options.Lifecycle.HealthTimeoutSeconds = 31;
            options.Lifecycle.ShutdownDrainSeconds = 121;

            var result = LifecycleConfigurationValidator.Validate(options);
            var failures = result.Failures?.ToArray() ?? Array.Empty<string>();

            Assert.False(result.Succeeded);
            Assert.Contains(failures, value => value.Contains("ReadTimeoutSeconds", StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("MutationTimeoutSeconds", StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("BulkTimeoutSeconds", StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("HealthTimeoutSeconds", StringComparison.Ordinal));
            Assert.Contains(failures, value => value.Contains("ShutdownDrainSeconds", StringComparison.Ordinal));
        }

        [Fact]
        public void ThrowIfInvalid_UsesStandardOptionsValidationException()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.BulkTimeoutSeconds = 0;

            var exception = Assert.Throws<OptionsValidationException>(() =>
                LifecycleConfigurationValidator.ThrowIfInvalid(options));

            Assert.Contains(
                exception.Failures,
                value => value.Contains("BulkTimeoutSeconds", StringComparison.Ordinal));
        }

        [Theory]
        [InlineData(1, 1, 1, 1, 1)]
        [InlineData(300, 300, 900, 30, 120)]
        [InlineData(20, 30, 60, 5, 25)]
        public void RangeBoundaries_AreAcceptedWhenCrossSectionContractAlsoValid(
            int read,
            int mutation,
            int bulk,
            int health,
            int drain)
        {
            var options = new ApiPlatformOptions();
            options.Health.Enabled = false;
            options.Lifecycle.ReadTimeoutSeconds = read;
            options.Lifecycle.MutationTimeoutSeconds = mutation;
            options.Lifecycle.BulkTimeoutSeconds = bulk;
            options.Lifecycle.HealthTimeoutSeconds = health;
            options.Lifecycle.ShutdownDrainSeconds = drain;

            Assert.True(LifecycleConfigurationValidator.Validate(options).Succeeded);
        }

        private static void AssertInvalid(ApiPlatformOptions options, string fragment)
        {
            var result = LifecycleConfigurationValidator.Validate(options);
            Assert.False(result.Succeeded);
            AssertContains(result, fragment);
        }

        private static void AssertContains(ValidateOptionsResult result, string fragment)
        {
            var failures = result.Failures?.ToArray() ?? Array.Empty<string>();
            Assert.Contains(
                failures,
                value => value.Contains(fragment, StringComparison.OrdinalIgnoreCase));
        }
    }
}
