using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleStartupValidationTests
    {
        [Fact]
        public void DefaultLifecycleAndHealthBudgets_RegisterSuccessfully()
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration();

            services.AddKentRehberiApiPlatform(configuration);

            Assert.Contains(
                services,
                descriptor => descriptor.ServiceType == typeof(ApiPlatformOptions));
        }

        [Fact]
        public void LifecycleReadTimeoutBelowMinimum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:ReadTimeoutSeconds", "0"));

            AssertFailureContains(exception, "ReadTimeoutSeconds");
        }

        [Fact]
        public void LifecycleReadTimeoutAboveMaximum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:ReadTimeoutSeconds", "301"));

            AssertFailureContains(exception, "ReadTimeoutSeconds");
        }

        [Fact]
        public void LifecycleMutationTimeoutBelowMinimum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:MutationTimeoutSeconds", "0"));

            AssertFailureContains(exception, "MutationTimeoutSeconds");
        }

        [Fact]
        public void LifecycleMutationTimeoutAboveMaximum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:MutationTimeoutSeconds", "301"));

            AssertFailureContains(exception, "MutationTimeoutSeconds");
        }

        [Fact]
        public void LifecycleBulkTimeoutBelowMinimum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:BulkTimeoutSeconds", "0"));

            AssertFailureContains(exception, "BulkTimeoutSeconds");
        }

        [Fact]
        public void LifecycleBulkTimeoutAboveMaximum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:BulkTimeoutSeconds", "901"));

            AssertFailureContains(exception, "BulkTimeoutSeconds");
        }

        [Fact]
        public void LifecycleHealthTimeoutBelowMinimum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:HealthTimeoutSeconds", "0"));

            AssertFailureContains(exception, "HealthTimeoutSeconds");
        }

        [Fact]
        public void LifecycleHealthTimeoutAboveMaximum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:HealthTimeoutSeconds", "31"));

            AssertFailureContains(exception, "HealthTimeoutSeconds");
        }

        [Fact]
        public void LifecycleDrainTimeoutBelowMinimum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:ShutdownDrainSeconds", "0"));

            AssertFailureContains(exception, "ShutdownDrainSeconds");
        }

        [Fact]
        public void LifecycleDrainTimeoutAboveMaximum_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:ShutdownDrainSeconds", "121"));

            AssertFailureContains(exception, "ShutdownDrainSeconds");
        }

        [Fact]
        public void HealthTimeoutAboveReadTimeout_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:ReadTimeoutSeconds", "4"),
                ("Platform:Lifecycle:HealthTimeoutSeconds", "5"),
                ("Platform:Health:DatabaseTimeoutSeconds", "3"));

            AssertFailureContains(exception, "cannot exceed ReadTimeoutSeconds");
        }

        [Fact]
        public void DatabaseTimeoutEqualToLifecycleHealthDeadline_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:Enabled", "true"),
                ("Platform:Lifecycle:HealthTimeoutSeconds", "5"),
                ("Platform:Health:DatabaseTimeoutSeconds", "5"));

            AssertFailureContains(exception, "DatabaseTimeoutSeconds");
            AssertFailureContains(exception, "HealthTimeoutSeconds");
        }

        [Fact]
        public void DatabaseTimeoutAboveLifecycleHealthDeadline_FailsDuringRegistration()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:Enabled", "true"),
                ("Platform:Lifecycle:HealthTimeoutSeconds", "5"),
                ("Platform:Health:DatabaseTimeoutSeconds", "6"));

            AssertFailureContains(exception, "DatabaseTimeoutSeconds");
        }

        [Fact]
        public void DatabaseTimeoutEqualToFrameworkFallbackDeadline_FailsWhenLifecycleDisabled()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:Enabled", "false"),
                ("Platform:Requests:TimeoutSeconds", "3"),
                ("Platform:Health:DatabaseTimeoutSeconds", "3"));

            AssertFailureContains(exception, "DatabaseTimeoutSeconds");
            AssertFailureContains(exception, "Requests:TimeoutSeconds");
        }

        [Fact]
        public void DatabaseTimeoutBelowFrameworkFallbackDeadline_IsAccepted()
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration(
                ("Platform:Lifecycle:Enabled", "false"),
                ("Platform:Requests:TimeoutSeconds", "4"),
                ("Platform:Health:DatabaseTimeoutSeconds", "3"));

            services.AddKentRehberiApiPlatform(configuration);

            var resolved = services
                .Single(descriptor => descriptor.ServiceType == typeof(ApiPlatformOptions))
                .ImplementationInstance as ApiPlatformOptions;
            Assert.NotNull(resolved);
            Assert.False(resolved!.Lifecycle.Enabled);
            Assert.Equal(4, resolved.Requests.TimeoutSeconds);
            Assert.Equal(3, resolved.Health.DatabaseTimeoutSeconds);
        }

        [Fact]
        public void DisabledHealthDoesNotImposeDependencyProbeDeadlineOrdering()
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration(
                ("Platform:Health:Enabled", "false"),
                ("Platform:Lifecycle:HealthTimeoutSeconds", "1"),
                ("Platform:Health:DatabaseTimeoutSeconds", "30"));

            services.AddKentRehberiApiPlatform(configuration);

            var resolved = services
                .Single(descriptor => descriptor.ServiceType == typeof(ApiPlatformOptions))
                .ImplementationInstance as ApiPlatformOptions;
            Assert.NotNull(resolved);
            Assert.False(resolved!.Health.Enabled);
        }

        [Fact]
        public void MultipleLifecycleFailures_AreAggregatedAtStartup()
        {
            var exception = RegisterInvalid(
                ("Platform:Lifecycle:ReadTimeoutSeconds", "0"),
                ("Platform:Lifecycle:MutationTimeoutSeconds", "301"),
                ("Platform:Lifecycle:BulkTimeoutSeconds", "901"),
                ("Platform:Lifecycle:HealthTimeoutSeconds", "31"),
                ("Platform:Lifecycle:ShutdownDrainSeconds", "121"));

            AssertFailureContains(exception, "ReadTimeoutSeconds");
            AssertFailureContains(exception, "MutationTimeoutSeconds");
            AssertFailureContains(exception, "BulkTimeoutSeconds");
            AssertFailureContains(exception, "HealthTimeoutSeconds");
            AssertFailureContains(exception, "ShutdownDrainSeconds");
            Assert.True(exception.Failures.Count() >= 5);
        }

        [Theory]
        [InlineData("1", "1", "1", "1", "1")]
        [InlineData("300", "300", "900", "30", "120")]
        [InlineData("20", "30", "60", "5", "25")]
        public void LifecycleRangeBoundaries_AreBoundThroughConfiguration(
            string read,
            string mutation,
            string bulk,
            string health,
            string drain)
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration(
                ("Platform:Health:Enabled", "false"),
                ("Platform:Lifecycle:ReadTimeoutSeconds", read),
                ("Platform:Lifecycle:MutationTimeoutSeconds", mutation),
                ("Platform:Lifecycle:BulkTimeoutSeconds", bulk),
                ("Platform:Lifecycle:HealthTimeoutSeconds", health),
                ("Platform:Lifecycle:ShutdownDrainSeconds", drain));

            services.AddKentRehberiApiPlatform(configuration);

            var resolved = services
                .Single(descriptor => descriptor.ServiceType == typeof(ApiPlatformOptions))
                .ImplementationInstance as ApiPlatformOptions;
            Assert.NotNull(resolved);
            Assert.Equal(int.Parse(read), resolved!.Lifecycle.ReadTimeoutSeconds);
            Assert.Equal(int.Parse(mutation), resolved.Lifecycle.MutationTimeoutSeconds);
            Assert.Equal(int.Parse(bulk), resolved.Lifecycle.BulkTimeoutSeconds);
            Assert.Equal(int.Parse(health), resolved.Lifecycle.HealthTimeoutSeconds);
            Assert.Equal(int.Parse(drain), resolved.Lifecycle.ShutdownDrainSeconds);
        }

        [Fact]
        public void ValidDependencyDeadlineOrdering_IsBoundExactly()
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration(
                ("Platform:Lifecycle:Enabled", "true"),
                ("Platform:Lifecycle:HealthTimeoutSeconds", "9"),
                ("Platform:Health:DatabaseTimeoutSeconds", "8"));

            services.AddKentRehberiApiPlatform(configuration);

            var resolved = services
                .Single(descriptor => descriptor.ServiceType == typeof(ApiPlatformOptions))
                .ImplementationInstance as ApiPlatformOptions;
            Assert.NotNull(resolved);
            Assert.Equal(9, resolved!.Lifecycle.HealthTimeoutSeconds);
            Assert.Equal(8, resolved.Health.DatabaseTimeoutSeconds);
        }

        [Fact]
        public void InvalidLifecycleConfigurationDoesNotPartiallyPopulateServiceCollection()
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration(
                ("Platform:Lifecycle:BulkTimeoutSeconds", "0"));

            Assert.Throws<OptionsValidationException>(() =>
                services.AddKentRehberiApiPlatform(configuration));

            Assert.DoesNotContain(
                services,
                descriptor => descriptor.ServiceType == typeof(ApiPlatformOptions));
        }

        private static OptionsValidationException RegisterInvalid(
            params (string Key, string Value)[] overrides)
        {
            var services = new ServiceCollection();
            var configuration = CreateConfiguration(overrides);
            return Assert.Throws<OptionsValidationException>(() =>
                services.AddKentRehberiApiPlatform(configuration));
        }

        private static IConfiguration CreateConfiguration(
            params (string Key, string Value)[] overrides)
        {
            var values = new Dictionary<string, string?>
            {
                ["ConnectionStrings:Primary"] =
                    "Host=localhost;Database=kent;Username=test;Password=test"
            };

            foreach (var (key, value) in overrides)
            {
                values[key] = value;
            }

            return new ConfigurationBuilder()
                .AddInMemoryCollection(values)
                .Build();
        }

        private static void AssertFailureContains(
            OptionsValidationException exception,
            string fragment)
        {
            Assert.Contains(
                exception.Failures,
                failure => failure.Contains(
                    fragment,
                    StringComparison.OrdinalIgnoreCase));
        }
    }
}
