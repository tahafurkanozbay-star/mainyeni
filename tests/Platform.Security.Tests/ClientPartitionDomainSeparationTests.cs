using Api.Core.Platform;
using Api.Core.Platform.ClientPartitioning;
using Microsoft.AspNetCore.Http;
using System.Net;
using System.Security.Claims;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ClientPartitionDomainSeparationTests
{
    [Theory]
    [InlineData("same-material", "192.0.2.1")]
    [InlineData("192.0.2.1", "192.0.2.1")]
    [InlineData("ipv4\n192.0.2.1", "192.0.2.1")]
    [InlineData("anon:collision-probe", "203.0.113.9")]
    public void AuthenticatedAndAnonymousNamespacesRemainDisjoint(string subject, string address)
    {
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
                new[] { new Claim("sub", subject) },
                authenticationType: "test"))
        };
        context.Connection.RemoteIpAddress = IPAddress.Parse(address);

        var userKey = ClientPartitionKeyResolver.ResolvePartitionKey(context, new ApiPlatformOptions());
        var anonymousKey = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(address));

        Assert.StartsWith("user:", userKey);
        Assert.StartsWith("anon:", anonymousKey);
        Assert.NotEqual(userKey, anonymousKey);
    }

    [Theory]
    [InlineData("2001:db8:1:2::1", 48)]
    [InlineData("2001:db8:1:2::1", 64)]
    [InlineData("2001:db8:1:2::1", 80)]
    [InlineData("2001:db8:1:2::1", 128)]
    public void Ipv6PartitionKeyIsBoundedRegardlessOfPrefix(string address, int prefix)
    {
        var key = ClientPartitionKeyResolver.ResolveAnonymousPartition(IPAddress.Parse(address), prefix);

        Assert.StartsWith("anon:", key);
        Assert.Equal(29, key.Length);
    }

    [Fact]
    public void ChangingIpv6PrefixChangesDomainEvenWhenNetworkTextIsOtherwiseCompatible()
    {
        var address = IPAddress.Parse("2001:db8:abcd:1234::");
        var prefix64 = ClientPartitionKeyResolver.ResolveAnonymousPartition(address, 64);
        var prefix80 = ClientPartitionKeyResolver.ResolveAnonymousPartition(address, 80);

        Assert.NotEqual(prefix64, prefix80);
    }
}
