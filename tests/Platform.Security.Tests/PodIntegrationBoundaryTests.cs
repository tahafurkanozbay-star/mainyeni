using System;
using Business.Extensions.Integrations.Operations;
using Xunit;

namespace Platform.Security.Tests;

public sealed class PodIntegrationBoundaryTests
{
    [Theory]
    [InlineData(2026, 9, 29, 0, 0, 2026, 9, 28)]
    [InlineData(2026, 9, 29, 8, 0, 2026, 9, 28)]
    [InlineData(2026, 9, 29, 9, 0, 2026, 9, 28)]
    [InlineData(2026, 9, 29, 9, 29, 2026, 9, 28)]
    [InlineData(2026, 9, 29, 9, 30, 2026, 9, 29)]
    [InlineData(2026, 9, 29, 9, 31, 2026, 9, 29)]
    [InlineData(2026, 9, 29, 23, 59, 2026, 9, 29)]
    public void ResolveServiceDate_UsesPreviousRosterOnlyBeforeCutoff(
        int year,
        int month,
        int day,
        int hour,
        int minute,
        int expectedYear,
        int expectedMonth,
        int expectedDay)
    {
        var localNow = new DateTime(year, month, day, hour, minute, 0, DateTimeKind.Local);

        var result = PodOperations.ResolveServiceDate(localNow);

        Assert.Equal(new DateTime(expectedYear, expectedMonth, expectedDay), result);
    }

    [Fact]
    public void ResolveServiceDate_HandlesMonthBoundary()
    {
        var localNow = new DateTime(2026, 10, 1, 8, 15, 0, DateTimeKind.Local);

        var result = PodOperations.ResolveServiceDate(localNow);

        Assert.Equal(new DateTime(2026, 9, 30), result);
    }

    [Fact]
    public void ResolveServiceDate_HandlesYearBoundary()
    {
        var localNow = new DateTime(2027, 1, 1, 9, 29, 59, DateTimeKind.Local);

        var result = PodOperations.ResolveServiceDate(localNow);

        Assert.Equal(new DateTime(2026, 12, 31), result);
    }

    [Fact]
    public void ResolveServiceDate_DropsTimeComponent()
    {
        var localNow = new DateTime(2026, 9, 29, 14, 42, 11, DateTimeKind.Local);

        var result = PodOperations.ResolveServiceDate(localNow);

        Assert.Equal(TimeSpan.Zero, result.TimeOfDay);
        Assert.Equal(new DateTime(2026, 9, 29), result);
    }

    [Fact]
    public void ServiceEndpoint_IsHttpsAndPinnedToExpectedAuthority()
    {
        var endpoint = new Uri(PodOperations.ServiceEndpoint, UriKind.Absolute);

        Assert.Equal(Uri.UriSchemeHttps, endpoint.Scheme);
        Assert.Equal("mvc.aeo.org.tr", endpoint.Host);
        Assert.Equal(443, endpoint.Port);
        Assert.Equal("/PublicSayfalar/WebServices/ws_AEO_Nobet.asmx", endpoint.AbsolutePath);
        Assert.True(string.IsNullOrEmpty(endpoint.Query));
        Assert.True(string.IsNullOrEmpty(endpoint.Fragment));
        Assert.True(string.IsNullOrEmpty(endpoint.UserInfo));
    }
}
