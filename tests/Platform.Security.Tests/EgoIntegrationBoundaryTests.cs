using System;
using Business.Extensions.Integrations.Operations;
using Xunit;

namespace Platform.Security.Tests;

public sealed class EgoIntegrationBoundaryTests
{
    [Theory]
    [InlineData("413", "413")]
    [InlineData(" 413-7 ", "413-7")]
    [InlineData("413/A", "413/A")]
    [InlineData("413.1", "413.1")]
    public void ValidateLineNumber_AcceptsCanonicalRouteIdentifiers(string input, string expected)
    {
        Assert.Equal(expected, HatDurakBilgiOperations.ValidateLineNumber(input));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("413?admin=true")]
    [InlineData("413#fragment")]
    [InlineData("413\\7")]
    [InlineData("413%2f7")]
    [InlineData("413 7")]
    [InlineData("413\r\nInjected: value")]
    [InlineData("../413")]
    public void ValidateLineNumber_RejectsNonCanonicalOrComponentSmugglingInput(string input)
    {
        Assert.Throws<ArgumentException>(() => HatDurakBilgiOperations.ValidateLineNumber(input));
    }

    [Fact]
    public void ValidateLineNumber_RejectsOversizedInput()
    {
        Assert.Throws<ArgumentException>(() => HatDurakBilgiOperations.ValidateLineNumber(new string('4', 33)));
    }
}
