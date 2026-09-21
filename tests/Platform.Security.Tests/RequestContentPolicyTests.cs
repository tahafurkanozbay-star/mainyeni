using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestContentPolicyTests
{
    [Theory]
    [InlineData("POST", true)]
    [InlineData("PUT", true)]
    [InlineData("PATCH", true)]
    [InlineData("DELETE", true)]
    [InlineData("GET", false)]
    [InlineData("HEAD", false)]
    [InlineData("OPTIONS", false)]
    public void MethodCanCarryBody_UsesExplicitPolicy(string method, bool expected)
    {
        Assert.Equal(expected, RequestContentPolicy.MethodCanCarryBody(method));
    }

    [Theory]
    [InlineData("application/json", "application/json")]
    [InlineData(" Application/JSON ", "application/json")]
    [InlineData("application/json; charset=utf-8", "application/json")]
    [InlineData("application/geo+json;profile=x", "application/geo+json")]
    [InlineData("", "")]
    [InlineData("   ", "")]
    public void NormalizeMediaType_IsStable(string input, string expected)
    {
        Assert.Equal(expected, RequestContentPolicy.NormalizeMediaType(input));
    }

    [Fact]
    public void IsAllowed_AcceptsExactMediaType()
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            "application/json; charset=utf-8",
            new[] { "application/json" }));
    }

    [Fact]
    public void IsAllowed_AcceptsVendorJsonThroughStructuredSuffixWildcard()
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            "application/vnd.kentrehberi.item+json",
            new[] { "application/*+json" }));
    }

    [Fact]
    public void IsAllowed_AcceptsTypeWildcard()
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            "image/png",
            new[] { "image/*" }));
    }

    [Fact]
    public void IsAllowed_RejectsUnknownMediaType()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "application/xml",
            new[] { "application/json", "application/*+json" }));
    }

    [Fact]
    public void NormalizeAllowedMediaTypes_RemovesBlankAndDuplicates()
    {
        var result = RequestContentPolicy.NormalizeAllowedMediaTypes(new[]
        {
            " application/json ",
            "APPLICATION/JSON",
            "",
            "application/geo+json; charset=utf-8"
        });

        Assert.Equal(2, result.Length);
        Assert.Contains("application/json", result);
        Assert.Contains("application/geo+json", result);
    }

    [Fact]
    public void HasBody_UsesPositiveContentLength()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentLength = 10;

        Assert.True(RequestContentPolicy.HasBody(context.Request));
    }

    [Fact]
    public void HasBody_RejectsZeroContentLength()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentLength = 0;

        Assert.False(RequestContentPolicy.HasBody(context.Request));
    }

    [Fact]
    public void HasBody_RecognizesTransferEncodingWhenLengthUnknown()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentLength = null;
        context.Request.Headers.TransferEncoding = "chunked";

        Assert.True(RequestContentPolicy.HasBody(context.Request));
    }

    [Fact]
    public void HasBody_ThrowsForNullRequest()
    {
        Assert.Throws<ArgumentNullException>(() => RequestContentPolicy.HasBody(null!));
    }
}
