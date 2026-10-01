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
    [InlineData("TRACE", false)]
    public void MethodCanCarryBody_UsesExplicitPolicy(string method, bool expected)
    {
        Assert.Equal(expected, RequestContentPolicy.MethodCanCarryBody(method));
    }

    [Theory]
    [InlineData("application/json", "application/json")]
    [InlineData(" Application/JSON ", "application/json")]
    [InlineData("application/json; charset=utf-8", "application/json")]
    [InlineData("application/geo+json;profile=x", "application/geo+json")]
    [InlineData("multipart/form-data; boundary=----kent", "multipart/form-data")]
    [InlineData("text/plain; charset=\"utf-8\"", "text/plain")]
    [InlineData("", "")]
    [InlineData("   ", "")]
    [InlineData("application", "")]
    [InlineData("application/", "")]
    [InlineData("/json", "")]
    [InlineData("application/*", "")]
    [InlineData("application/json, text/plain", "")]
    public void NormalizeMediaType_UsesTypedParser(string input, string expected)
    {
        Assert.Equal(expected, RequestContentPolicy.NormalizeMediaType(input));
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("application/problem+json")]
    [InlineData("application/vnd.kentrehberi.item+json; charset=utf-8")]
    [InlineData("multipart/form-data; boundary=abc123")]
    public void TryNormalizeMediaType_AcceptsWellFormedEntityTypes(string input)
    {
        Assert.True(RequestContentPolicy.TryNormalizeMediaType(input, out var normalized));
        Assert.False(string.IsNullOrWhiteSpace(normalized));
        Assert.DoesNotContain(";", normalized, StringComparison.Ordinal);
        Assert.DoesNotContain("*", normalized, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("application")]
    [InlineData("application/")]
    [InlineData("application/*")]
    [InlineData("*/json")]
    [InlineData("application/json\r\nX-Test: value")]
    [InlineData("application/json,application/xml")]
    public void TryNormalizeMediaType_RejectsMalformedOrWildcardEntityTypes(string input)
    {
        Assert.False(RequestContentPolicy.TryNormalizeMediaType(input!, out var normalized));
        Assert.Equal(string.Empty, normalized);
    }

    [Fact]
    public void IsAllowed_AcceptsExactMediaType()
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            "application/json; charset=utf-8",
            new[] { "application/json" }));
    }

    [Theory]
    [InlineData("application/vnd.kentrehberi.item+json")]
    [InlineData("application/problem+json")]
    [InlineData("application/geo+json")]
    public void IsAllowed_AcceptsStructuredSuffixWildcard(string contentType)
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            contentType,
            new[] { "application/*+json" }));
    }

    [Fact]
    public void IsAllowed_StructuredSuffixWildcardRequiresNonEmptyPrefix()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "application/+json",
            new[] { "application/*+json" }));
    }

    [Theory]
    [InlineData("image/png")]
    [InlineData("image/jpeg")]
    [InlineData("image/svg+xml")]
    public void IsAllowed_AcceptsTypeWildcard(string contentType)
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            contentType,
            new[] { "image/*" }));
    }

    [Fact]
    public void IsAllowed_GlobalWildcardMatchesWellFormedMediaType()
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            "application/octet-stream",
            new[] { "*/*" }));
    }

    [Fact]
    public void IsAllowed_GlobalWildcardStillRejectsMalformedMediaType()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "not-a-media-type",
            new[] { "*/*" }));
    }

    [Fact]
    public void IsAllowed_RejectsUnknownMediaType()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "application/xml",
            new[] { "application/json", "application/*+json" }));
    }

    [Fact]
    public void IsAllowed_RejectsCrossTypeStructuredSuffixMatch()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "text/vendor+json",
            new[] { "application/*+json" }));
    }

    [Fact]
    public void IsAllowed_IgnoresMalformedAllowlistEntries()
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            "application/json",
            new[]
            {
                "not-a-media-type",
                "application/json"
            }));
    }

    [Fact]
    public void IsAllowed_ReturnsFalseForNullAllowlist()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "application/json",
            null!));
    }

    [Theory]
    [InlineData("application/json", "application", "json")]
    [InlineData(" Application/JSON ", "application", "json")]
    [InlineData("application/*", "application", "*")]
    [InlineData("application/*+json", "application", "*+json")]
    [InlineData("*/*", "*", "*")]
    [InlineData("text/plain; charset=utf-8", "text", "plain")]
    public void TryNormalizeAllowedMediaTypePattern_AcceptsBoundedGrammar(
        string value,
        string expectedType,
        string expectedSubtype)
    {
        Assert.True(RequestContentPolicy.TryNormalizeAllowedMediaTypePattern(
            value,
            out var type,
            out var subtype));
        Assert.Equal(expectedType, type);
        Assert.Equal(expectedSubtype, subtype);
    }

    [Theory]
    [InlineData("")]
    [InlineData("application")]
    [InlineData("application/")]
    [InlineData("/json")]
    [InlineData("application/**")]
    [InlineData("*/json")]
    [InlineData("application/*+")]
    [InlineData("application/json/extra")]
    [InlineData("application/json\r\ntext/plain")]
    public void TryNormalizeAllowedMediaTypePattern_RejectsMalformedGrammar(string value)
    {
        Assert.False(RequestContentPolicy.TryNormalizeAllowedMediaTypePattern(
            value,
            out _,
            out _));
    }

    [Fact]
    public void NormalizeAllowedMediaTypes_RemovesBlankMalformedAndDuplicates()
    {
        var result = RequestContentPolicy.NormalizeAllowedMediaTypes(new[]
        {
            " application/json ",
            "APPLICATION/JSON",
            "",
            "not-a-media-type",
            "application/geo+json; charset=utf-8",
            "application/*+json"
        });

        Assert.Equal(3, result.Length);
        Assert.Contains("application/json", result);
        Assert.Contains("application/geo+json", result);
        Assert.Contains("application/*+json", result);
    }

    [Fact]
    public void NormalizeAllowedMediaTypes_HandlesNull()
    {
        Assert.Empty(RequestContentPolicy.NormalizeAllowedMediaTypes(null!));
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
    public void HasBody_RejectsUnknownLengthWithoutTransferEncoding()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentLength = null;

        Assert.False(RequestContentPolicy.HasBody(context.Request));
    }

    [Fact]
    public void HasBody_ThrowsForNullRequest()
    {
        Assert.Throws<ArgumentNullException>(() => RequestContentPolicy.HasBody(null!));
    }
}
