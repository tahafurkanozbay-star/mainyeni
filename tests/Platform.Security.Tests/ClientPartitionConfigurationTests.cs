using Api.Core.Platform;
using Microsoft.Extensions.Configuration;
using System;
using System.Collections.Generic;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ClientPartitionConfigurationTests
{
    [Fact] public void ResolveOptions_DefaultsToAuthenticatedStablePartitioning() { var o=Resolve(); Assert.True(o.ClientPartitioning.PartitionAuthenticatedUsers); Assert.Equal(64,o.ClientPartitioning.AnonymousIpv6PrefixLength); }
    [Theory] [InlineData("true",true)] [InlineData("false",false)] [InlineData("TRUE",true)] [InlineData("FALSE",false)]
    public void ResolveOptions_BindsModernAuthenticatedPartitionSwitch(string value,bool expected){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:PartitionAuthenticatedUsers",value}});Assert.Equal(expected,o.ClientPartitioning.PartitionAuthenticatedUsers);}
    [Theory] [InlineData("48")] [InlineData("56")] [InlineData("64")] [InlineData("80")] [InlineData("96")] [InlineData("128")]
    public void ResolveOptions_BindsModernIpv6PrefixLength(string value){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:AnonymousIpv6PrefixLength",value}});Assert.Equal(int.Parse(value),o.ClientPartitioning.AnonymousIpv6PrefixLength);}
    [Theory] [InlineData("true",true)] [InlineData("false",false)]
    public void ResolveOptions_LegacyRateLimitSwitchBridgesWhenModernValueAbsent(string value,bool expected){var o=Resolve(new Dictionary<string,string?>{{"Platform:RateLimiting:PartitionAuthenticatedUsers",value}});Assert.Equal(expected,o.ClientPartitioning.PartitionAuthenticatedUsers);}
    [Fact] public void ResolveOptions_ModernValueAlwaysWinsOverLegacyValue(){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:PartitionAuthenticatedUsers","false"},{"Platform:RateLimiting:PartitionAuthenticatedUsers","true"}});Assert.False(o.ClientPartitioning.PartitionAuthenticatedUsers);}
    [Fact] public void ResolveOptions_ModernTrueWinsOverLegacyFalse(){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:PartitionAuthenticatedUsers","true"},{"Platform:RateLimiting:PartitionAuthenticatedUsers","false"}});Assert.True(o.ClientPartitioning.PartitionAuthenticatedUsers);}
    [Theory] [InlineData("not-a-bool")] [InlineData("1")] [InlineData("yes")]
    public void ResolveOptions_MalformedLegacyValueCannotDisableModernDefault(string value){var o=Resolve(new Dictionary<string,string?>{{"Platform:RateLimiting:PartitionAuthenticatedUsers",value}});Assert.True(o.ClientPartitioning.PartitionAuthenticatedUsers);}
    [Fact] public void ResolveOptions_DoesNotAliasClientPartitioningAndRateLimitOptions(){var o=Resolve();o.ClientPartitioning.PartitionAuthenticatedUsers=false;Assert.True(o.RateLimiting.PartitionAuthenticatedUsers);}
    [Fact] public void ResolveOptions_RepeatedResolutionProducesIndependentOptionGraphs(){var a=Resolve();var b=Resolve();a.ClientPartitioning.PartitionAuthenticatedUsers=false;a.ClientPartitioning.AnonymousIpv6PrefixLength=96;Assert.True(b.ClientPartitioning.PartitionAuthenticatedUsers);Assert.Equal(64,b.ClientPartitioning.AnonymousIpv6PrefixLength);}
    [Fact] public void ResolveOptions_PartitionConfigurationDoesNotChangeRateLimitCapacity(){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:PartitionAuthenticatedUsers","false"},{"Platform:ClientPartitioning:AnonymousIpv6PrefixLength","80"}});Assert.Equal(240,o.RateLimiting.PermitLimit);Assert.Equal(60,o.RateLimiting.WindowSeconds);Assert.Equal(0,o.RateLimiting.QueueLimit);}
    [Fact] public void ResolveOptions_RateLimitCapacityDoesNotChangePartitionPolicy(){var o=Resolve(new Dictionary<string,string?>{{"Platform:RateLimiting:PermitLimit","777"},{"Platform:RateLimiting:WindowSeconds","9"},{"Platform:RateLimiting:QueueLimit","3"}});Assert.True(o.ClientPartitioning.PartitionAuthenticatedUsers);Assert.Equal(64,o.ClientPartitioning.AnonymousIpv6PrefixLength);Assert.Equal(777,o.RateLimiting.PermitLimit);Assert.Equal(9,o.RateLimiting.WindowSeconds);Assert.Equal(3,o.RateLimiting.QueueLimit);}
    [Fact] public void ResolveOptions_PreservesOtherPlatformSectionsAlongsidePartitioning(){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:PartitionAuthenticatedUsers","false"},{"Platform:Requests:CorrelationHeaderName"," X-Correlation-Test "},{"Platform:ForwardedHeaders:ForwardLimit","2"},{"Platform:Governance:Concurrency:MaxConcurrentRequests","321"}});Assert.False(o.ClientPartitioning.PartitionAuthenticatedUsers);Assert.Equal("X-Correlation-Test",o.Requests.CorrelationHeaderName);Assert.Equal(2,o.ForwardedHeaders.ForwardLimit);Assert.Equal(321,o.Governance.Concurrency.MaxConcurrentRequests);}
    [Fact] public void ResolveOptions_NullConfigurationFailsBeforeBinding()=>Assert.Throws<ArgumentNullException>(()=>ApiPlatformConfigurationResolver.ResolveOptions(null!));
    [Fact] public void ResolveOptions_EmptyConfigurationProducesNonNullNestedPolicies(){var o=Resolve();Assert.NotNull(o.ClientPartitioning);Assert.NotNull(o.RateLimiting);Assert.NotNull(o.ForwardedHeaders);Assert.NotNull(o.Governance);Assert.NotNull(o.Requests);}
    [Theory] [InlineData("48",false)] [InlineData("64",true)] [InlineData("96",false)] [InlineData("128",true)]
    public void ResolveOptions_CombinedModernValuesBindIndependently(string prefix,bool partitionUsers){var o=Resolve(new Dictionary<string,string?>{{"Platform:ClientPartitioning:AnonymousIpv6PrefixLength",prefix},{"Platform:ClientPartitioning:PartitionAuthenticatedUsers",partitionUsers.ToString()}});Assert.Equal(int.Parse(prefix),o.ClientPartitioning.AnonymousIpv6PrefixLength);Assert.Equal(partitionUsers,o.ClientPartitioning.PartitionAuthenticatedUsers);}
    private static ApiPlatformOptions Resolve(IDictionary<string,string?>? values=null){var b=new ConfigurationBuilder();if(values!=null)b.AddInMemoryCollection(values);return ApiPlatformConfigurationResolver.ResolveOptions(b.Build());}
}
