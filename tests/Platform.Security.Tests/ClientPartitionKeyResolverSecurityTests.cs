using Api.Core.Platform;
using Api.Core.Platform.ClientPartitioning;
using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Security.Claims;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ClientPartitionKeyResolverSecurityTests
{
    [Fact]
    public void ResolvePartitionKey_RejectsNullContext()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ClientPartitionKeyResolver.ResolvePartitionKey(null!, new ApiPlatformOptions()));
    }

    [Fact]
    public void ResolvePartitionKey_RejectsNullOptions()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ClientPartitionKeyResolver.ResolvePartitionKey(new DefaultHttpContext(), null!));
    }

    [Fact]
    public void ResolveAnonymousPartition_NullAddressUsesSingleBoundedUnknownBucket()
    {
        Assert.Equal("client:unknown", ClientPartitionKeyResolver.ResolveAnonymousPartition(null!));
    }

    [Theory]
    [InlineData("192.0.2.10")]
    [InlineData("198.51.100.200")]
    [InlineData("203.0.113.254")]
    public void ResolveAnonymousPartition_Ipv4NeverLeaksRawAddress(string address)
    {
        var key = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(address));

        Assert.StartsWith("anon:", key, StringComparison.Ordinal);
        Assert.Equal("anon:".Length + 24, key.Length);
        Assert.DoesNotContain(address, key, StringComparison.OrdinalIgnoreCase);
        Assert.All(key["anon:".Length..], character => Assert.True(Uri.IsHexDigit(character)));
    }

    [Theory]
    [InlineData("192.0.2.10", "::ffff:192.0.2.10")]
    [InlineData("198.51.100.20", "::ffff:198.51.100.20")]
    public void ResolveAnonymousPartition_Ipv4MappedIpv6CanonicalizesToIpv4(string ipv4, string mapped)
    {
        Assert.Equal(
            ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(ipv4)),
            ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(mapped)));
    }

    [Theory]
    [InlineData("2001:db8:1234:5678::1", "2001:db8:1234:5678:ffff::1", 64, true)]
    [InlineData("2001:db8:1234:5678::1", "2001:db8:1234:5679::1", 64, false)]
    [InlineData("2001:db8:1234:5678::1", "2001:db8:1234:5678::ffff", 80, true)]
    [InlineData("2001:db8:1234:5678::1", "2001:db8:1234:5678:1::1", 80, false)]
    public void ResolveAnonymousPartition_Ipv6PrefixControlsPrivacyGrouping(
        string first,
        string second,
        int prefixLength,
        bool expectedEqual)
    {
        var left = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(first), prefixLength);
        var right = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(second), prefixLength);

        Assert.Equal(expectedEqual, string.Equals(left, right, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(0, 48)]
    [InlineData(1, 48)]
    [InlineData(47, 48)]
    [InlineData(48, 48)]
    [InlineData(64, 64)]
    [InlineData(96, 96)]
    [InlineData(128, 128)]
    [InlineData(129, 128)]
    [InlineData(4096, 128)]
    public void ResolveAnonymousPartition_Ipv6PrefixIsClampedToSecurityBounds(int requested, int effective)
    {
        var address = IPAddress.Parse("2001:db8:abcd:1234:5678:90ab:cdef:1234");
        var actual = ClientPartitionKeyResolver.ResolveAnonymousPartition(address, requested);
        var expected = ClientPartitionKeyResolver.ResolveAnonymousPartition(address, effective);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void ResolveAnonymousPartition_IsDeterministicAcrossRepeatedCalls()
    {
        var address = IPAddress.Parse("2001:db8:abcd:1234::42");
        var keys = Enumerable.Range(0, 100)
            .Select(_ => ClientPartitionKeyResolver.ResolveAnonymousPartition(address, 64))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        Assert.Single(keys);
    }

    [Fact]
    public void ResolveAnonymousPartition_DomainSeparatesIpv4AndIpv6Material()
    {
        var ipv4 = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse("192.0.2.1"));
        var ipv6 = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse("2001:db8::c000:201"), 128);

        Assert.NotEqual(ipv4, ipv6);
    }

    [Fact]
    public void ResolvePartitionKey_StableSubjectWinsOverRemoteAddress()
    {
        var first = Context("203.0.113.10", Authenticated("subject-42"));
        var second = Context("198.51.100.200", Authenticated("subject-42"));

        Assert.Equal(Resolve(first), Resolve(second));
        Assert.StartsWith("user:", Resolve(first), StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvePartitionKey_DifferentStableSubjectsHaveIndependentBuckets()
    {
        var address = "203.0.113.10";

        Assert.NotEqual(
            Resolve(Context(address, Authenticated("subject-a"))),
            Resolve(Context(address, Authenticated("subject-b"))));
    }

    [Fact]
    public void ResolvePartitionKey_SubjectValueIsTrimmedBeforeHashing()
    {
        Assert.Equal(
            Resolve(Context("192.0.2.1", Authenticated("subject-a"))),
            Resolve(Context("192.0.2.1", Authenticated("  subject-a  "))));
    }

    [Fact]
    public void ResolvePartitionKey_NameIdentifierIsStableFallback()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim(ClaimTypes.NameIdentifier, "stable-id") },
            authenticationType: "test"));

        var key = Resolve(Context("203.0.113.5", principal));

        Assert.StartsWith("user:", key, StringComparison.Ordinal);
        Assert.DoesNotContain("stable-id", key, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvePartitionKey_SubClaimTakesPrecedenceOverNameIdentifier()
    {
        var withBoth = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("sub", "subject-primary"),
            new Claim(ClaimTypes.NameIdentifier, "identifier-secondary")
        }, "test"));
        var subjectOnly = Authenticated("subject-primary");

        Assert.Equal(
            Resolve(Context("203.0.113.5", withBoth)),
            Resolve(Context("198.51.100.5", subjectOnly)));
    }

    [Fact]
    public void ResolvePartitionKey_MutableDisplayNameNeverBecomesAuthenticatedPartition()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim(ClaimTypes.Name, "mutable-display-name") },
            authenticationType: "test"));
        var context = Context("203.0.113.77", principal);

        var key = Resolve(context);

        Assert.StartsWith("anon:", key, StringComparison.Ordinal);
        Assert.DoesNotContain("mutable-display-name", key, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolvePartitionKey_AnonymousClaimsCannotEscalateToUserPartition()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("sub", "spoofed-subject"),
            new Claim(ClaimTypes.NameIdentifier, "spoofed-id")
        }));

        Assert.StartsWith(
            "anon:",
            Resolve(Context("203.0.113.77", principal)),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvePartitionKey_DisablingAuthenticatedPartitionUsesNetworkIdentity()
    {
        var options = new ApiPlatformOptions();
        options.ClientPartitioning.PartitionAuthenticatedUsers = false;
        var first = Context("203.0.113.77", Authenticated("same-user"));
        var second = Context("198.51.100.77", Authenticated("same-user"));

        var firstKey = ClientPartitionKeyResolver.ResolvePartitionKey(first, options);
        var secondKey = ClientPartitionKeyResolver.ResolvePartitionKey(second, options);

        Assert.StartsWith("anon:", firstKey, StringComparison.Ordinal);
        Assert.StartsWith("anon:", secondKey, StringComparison.Ordinal);
        Assert.NotEqual(firstKey, secondKey);
    }

    [Fact]
    public void ResolvePartitionKey_ForwardingHeadersDoNotOverrideConnectionBoundary()
    {
        var context = Context("203.0.113.10", new ClaimsPrincipal(new ClaimsIdentity()));
        context.Request.Headers["X-Forwarded-For"] = "198.51.100.25";
        context.Request.Headers["Forwarded"] = "for=198.51.100.26;proto=https";
        context.Request.Headers["X-Real-IP"] = "198.51.100.27";

        var expected = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse("203.0.113.10"));

        Assert.Equal(expected, Resolve(context));
    }

    [Fact]
    public void ResolvePartitionKey_NoRemoteAddressUsesBoundedUnknownBucket()
    {
        var context = new DefaultHttpContext();

        Assert.Equal("client:unknown", Resolve(context));
    }

    [Fact]
    public void ResolvePartitionKey_UserKeyNeverContainsClaimMaterial()
    {
        const string secretLikeSubject = "tenant/alpha:user@example.test:very-sensitive-id";
        var key = Resolve(Context("203.0.113.10", Authenticated(secretLikeSubject)));

        Assert.StartsWith("user:", key, StringComparison.Ordinal);
        Assert.Equal("user:".Length + 24, key.Length);
        Assert.DoesNotContain("tenant", key, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("example", key, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sensitive", key, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolvePartitionKey_LargeSubjectRemainsBounded()
    {
        var subject = new string('x', 100_000);
        var key = Resolve(Context("203.0.113.10", Authenticated(subject)));

        Assert.Equal("user:".Length + 24, key.Length);
    }

    [Fact]
    public void ResolvePartitionKey_ManySubjectsProduceDistinctBoundedKeys()
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < 512; index++)
        {
            var key = Resolve(Context("203.0.113.10", Authenticated("subject-" + index)));
            Assert.True(keys.Add(key));
            Assert.Equal("user:".Length + 24, key.Length);
        }

        Assert.Equal(512, keys.Count);
    }

    [Theory]
    [InlineData("10.0.0.1")]
    [InlineData("127.0.0.1")]
    [InlineData("169.254.10.20")]
    [InlineData("172.16.1.2")]
    [InlineData("192.168.1.2")]
    [InlineData("224.0.0.1")]
    public void ResolveAnonymousPartition_AllIpv4ClassesRemainPseudonymous(string address)
    {
        var key = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(address));

        Assert.StartsWith("anon:", key, StringComparison.Ordinal);
        Assert.DoesNotContain(address, key, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("::1")]
    [InlineData("fe80::1")]
    [InlineData("fc00::1")]
    [InlineData("2001:db8::1")]
    public void ResolveAnonymousPartition_AllIpv6ClassesRemainPseudonymous(string address)
    {
        var key = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(address));

        Assert.StartsWith("anon:", key, StringComparison.Ordinal);
        Assert.DoesNotContain(address, key, StringComparison.OrdinalIgnoreCase);
    }

    private static string Resolve(DefaultHttpContext context)
    {
        return ClientPartitionKeyResolver.ResolvePartitionKey(context, new ApiPlatformOptions());
    }

    private static DefaultHttpContext Context(string address, ClaimsPrincipal principal)
    {
        var context = new DefaultHttpContext
        {
            User = principal
        };
        context.Connection.RemoteIpAddress = IPAddress.Parse(address);
        return context;
    }

    private static ClaimsPrincipal Authenticated(string subject)
    {
        return new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("sub", subject) },
            authenticationType: "test"));
    }
}
