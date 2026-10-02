using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using System;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestTimeoutAuthorityTests
    {
        [Fact]
        public void LifecycleEnabled_SelectsOnlyLifecycleTimeoutAuthority()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = true;

            Assert.True(RequestTimeoutAuthority.UsesLifecycleTimeouts(options));
            Assert.False(RequestTimeoutAuthority.UsesFrameworkDefaultTimeout(options));
        }

        [Fact]
        public void LifecycleDisabled_SelectsOnlyFrameworkFallbackAuthority()
        {
            var options = new ApiPlatformOptions();
            options.Lifecycle.Enabled = false;

            Assert.False(RequestTimeoutAuthority.UsesLifecycleTimeouts(options));
            Assert.True(RequestTimeoutAuthority.UsesFrameworkDefaultTimeout(options));
        }

        [Fact]
        public void NullOptions_AreRejectedFailClosed()
        {
            Assert.Throws<ArgumentNullException>(() =>
                RequestTimeoutAuthority.UsesLifecycleTimeouts(null!));
        }

        [Fact]
        public void MissingLifecycleOptions_AreRejectedFailClosed()
        {
            var options = new ApiPlatformOptions
            {
                Lifecycle = null!
            };

            Assert.Throws<ArgumentException>(() =>
                RequestTimeoutAuthority.UsesFrameworkDefaultTimeout(options));
        }

        [Fact]
        public void BulkBudgetCanExceedLegacyDefaultWithoutCompetingTimeoutAuthority()
        {
            var options = new ApiPlatformOptions();
            options.Requests.TimeoutSeconds = 30;
            options.Lifecycle.Enabled = true;
            options.Lifecycle.BulkTimeoutSeconds = 60;

            Assert.True(options.Lifecycle.BulkTimeoutSeconds > options.Requests.TimeoutSeconds);
            Assert.True(RequestTimeoutAuthority.UsesLifecycleTimeouts(options));
            Assert.False(RequestTimeoutAuthority.UsesFrameworkDefaultTimeout(options));
        }
    }
}
