using Api.Core.Platform;
using Api.Core.Platform.RateLimiting;
using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Net;
using System.Security.Claims;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class ClientRateLimitPartitionerTests
    {
        [Fact]
        public void ResolvePartitionKey_UsesNormalizedRemoteAddressForAnonymousClient()
        {
            var context = CreateContext();
            context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.25");

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.Equal("ip:203.0.113.25", key);
        }

        [Fact]
        public void ResolvePartitionKey_NormalizesIpv4MappedIpv6Address()
        {
            var context = CreateContext();
            context.Connection.RemoteIpAddress = IPAddress.Parse("::ffff:203.0.113.42");

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.Equal("ip:203.0.113.42", key);
        }

        [Fact]
        public void ResolvePartitionKey_UsesStablePseudonymousAuthenticatedPartition()
        {
            var first = CreateAuthenticatedContext("person-42");
            var second = CreateAuthenticatedContext("person-42");
            first.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.1");
            second.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.1");

            var firstKey = ClientRateLimitPartitioner.ResolvePartitionKey(first, CreateOptions());
            var secondKey = ClientRateLimitPartitioner.ResolvePartitionKey(second, CreateOptions());

            Assert.Equal(firstKey, secondKey);
            Assert.StartsWith("user:", firstKey, StringComparison.Ordinal);
            Assert.DoesNotContain("person-42", firstKey, StringComparison.Ordinal);
            Assert.Equal("user:".Length + 24, firstKey.Length);
        }

        [Fact]
        public void ResolvePartitionKey_DifferentSubjectsHaveDifferentPartitions()
        {
            var first = CreateAuthenticatedContext("person-1");
            var second = CreateAuthenticatedContext("person-2");

            var firstKey = ClientRateLimitPartitioner.ResolvePartitionKey(first, CreateOptions());
            var secondKey = ClientRateLimitPartitioner.ResolvePartitionKey(second, CreateOptions());

            Assert.NotEqual(firstKey, secondKey);
        }

        [Fact]
        public void ResolvePartitionKey_NameIdentifierIsUsedWhenSubjectClaimMissing()
        {
            var identity = new ClaimsIdentity(
                new[] { new Claim(ClaimTypes.NameIdentifier, "account-77") },
                authenticationType: "test");
            var context = CreateContext();
            context.User = new ClaimsPrincipal(identity);

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.StartsWith("user:", key, StringComparison.Ordinal);
            Assert.DoesNotContain("account-77", key, StringComparison.Ordinal);
        }

        [Fact]
        public void ResolvePartitionKey_NameFallbackDoesNotExposeName()
        {
            var identity = new ClaimsIdentity(authenticationType: "test")
            {
                Label = "test"
            };
            identity.AddClaim(new Claim(identity.NameClaimType, "human-readable-user"));
            var context = CreateContext();
            context.User = new ClaimsPrincipal(identity);

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.StartsWith("user:", key, StringComparison.Ordinal);
            Assert.DoesNotContain("human-readable-user", key, StringComparison.Ordinal);
        }

        [Fact]
        public void ResolvePartitionKey_CanPartitionAuthenticatedRequestByAddressWhenConfigured()
        {
            var context = CreateAuthenticatedContext("person-42");
            context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.9");
            var options = CreateOptions();
            options.RateLimiting.PartitionAuthenticatedUsers = false;

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, options);

            Assert.Equal("ip:203.0.113.9", key);
        }

        [Fact]
        public void ResolvePartitionKey_UsesBoundedUnknownKeyWhenAddressUnavailable()
        {
            var context = CreateContext();
            context.Connection.RemoteIpAddress = null;

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.Equal("client:unknown", key);
        }

        [Theory]
        [InlineData("OPTIONS")]
        [InlineData("options")]
        public void ShouldBypass_ExemptsCorsPreflightWhenEnabled(string method)
        {
            var context = CreateContext();
            context.Request.Method = method;
            var options = CreateOptions();

            var bypass = ClientRateLimitPartitioner.ShouldBypass(context, options);

            Assert.True(bypass);
            Assert.Equal(
                "bypass:preflight",
                ClientRateLimitPartitioner.ResolveBypassPartition(context, options));
        }

        [Fact]
        public void ShouldBypass_DoesNotExemptOptionsWhenDisabled()
        {
            var context = CreateContext();
            context.Request.Method = HttpMethods.Options;
            var options = CreateOptions();
            options.RateLimiting.ExemptOptionsRequests = false;

            Assert.False(ClientRateLimitPartitioner.ShouldBypass(context, options));
        }

        [Theory]
        [InlineData("/health/live")]
        [InlineData("/HEALTH/LIVE")]
        [InlineData("/health/live/")]
        [InlineData("/health/ready")]
        public void ShouldBypass_ExemptsConfiguredHealthEndpoints(string path)
        {
            var context = CreateContext();
            context.Request.Path = path;
            var options = CreateOptions();

            var bypass = ClientRateLimitPartitioner.ShouldBypass(context, options);

            Assert.True(bypass);
            Assert.Equal(
                "bypass:health",
                ClientRateLimitPartitioner.ResolveBypassPartition(context, options));
        }

        [Theory]
        [InlineData("/health")]
        [InlineData("/health/live/extra")]
        [InlineData("/api/health/live")]
        public void ShouldBypass_DoesNotUsePrefixMatchingForHealthEndpoints(string path)
        {
            var context = CreateContext();
            context.Request.Path = path;

            Assert.False(ClientRateLimitPartitioner.ShouldBypass(context, CreateOptions()));
        }

        [Fact]
        public void ShouldBypass_DoesNotExemptHealthWhenHealthChecksDisabled()
        {
            var context = CreateContext();
            context.Request.Path = "/health/live";
            var options = CreateOptions();
            options.Health.Enabled = false;

            Assert.False(ClientRateLimitPartitioner.ShouldBypass(context, options));
        }

        [Fact]
        public void ShouldBypass_ReturnsTrueWhenGlobalLimiterDisabled()
        {
            var context = CreateContext();
            context.Request.Path = "/api/data";
            var options = CreateOptions();
            options.RateLimiting.Enabled = false;

            Assert.True(ClientRateLimitPartitioner.ShouldBypass(context, options));
        }

        [Fact]
        public void ShouldBypass_ThrowsForMissingContext()
        {
            Assert.Throws<ArgumentNullException>(() =>
                ClientRateLimitPartitioner.ShouldBypass(null!, CreateOptions()));
        }

        [Fact]
        public void ShouldBypass_ThrowsForMissingOptions()
        {
            Assert.Throws<ArgumentNullException>(() =>
                ClientRateLimitPartitioner.ShouldBypass(CreateContext(), null!));
        }

        [Fact]
        public void ResolvePartitionKey_ThrowsForMissingContext()
        {
            Assert.Throws<ArgumentNullException>(() =>
                ClientRateLimitPartitioner.ResolvePartitionKey(null!, CreateOptions()));
        }

        [Fact]
        public void ResolvePartitionKey_ThrowsForMissingOptions()
        {
            Assert.Throws<ArgumentNullException>(() =>
                ClientRateLimitPartitioner.ResolvePartitionKey(CreateContext(), null!));
        }

        [Fact]
        public void ResolvePartitionKey_DoesNotReadSpoofableForwardedForHeaderDirectly()
        {
            var context = CreateContext();
            context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.10");
            context.Request.Headers["X-Forwarded-For"] = "198.51.100.99";

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.Equal("ip:203.0.113.10", key);
        }

        [Fact]
        public void ResolvePartitionKey_DoesNotReadApiKeyHeaderAsIdentity()
        {
            var context = CreateContext();
            context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.11");
            context.Request.Headers["X-Api-Key"] = "sensitive-client-key";

            var key = ClientRateLimitPartitioner.ResolvePartitionKey(context, CreateOptions());

            Assert.Equal("ip:203.0.113.11", key);
            Assert.DoesNotContain("sensitive-client-key", key, StringComparison.Ordinal);
        }

        private static DefaultHttpContext CreateContext()
        {
            var context = new DefaultHttpContext();
            context.Request.Method = HttpMethods.Get;
            context.Request.Path = "/api/resource";
            return context;
        }

        private static DefaultHttpContext CreateAuthenticatedContext(string subject)
        {
            var context = CreateContext();
            var identity = new ClaimsIdentity(
                new[] { new Claim("sub", subject) },
                authenticationType: "test");
            context.User = new ClaimsPrincipal(identity);
            return context;
        }

        private static ApiPlatformOptions CreateOptions()
        {
            return new ApiPlatformOptions
            {
                RateLimiting = new ApiPlatformOptions.RateLimitOptions
                {
                    Enabled = true,
                    PermitLimit = 100,
                    WindowSeconds = 60,
                    SegmentsPerWindow = 6,
                    QueueLimit = 0,
                    ExemptOptionsRequests = true,
                    ExemptHealthChecks = true,
                    PartitionAuthenticatedUsers = true,
                    RetryAfterSeconds = 1
                },
                Health = new ApiPlatformOptions.HealthOptions
                {
                    Enabled = true,
                    LivenessPath = "/health/live",
                    ReadinessPath = "/health/ready",
                    DatabaseTimeoutSeconds = 3
                }
            };
        }
    }
}
