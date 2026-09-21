using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestHeaderInspectorTests
{
    [Fact]
    public void Inspect_EmptyHeaders_ReturnsZeroes()
    {
        var context = new DefaultHttpContext();

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.Equal(0, snapshot.HeaderCount);
        Assert.Equal(0, snapshot.HeaderValueCount);
        Assert.Equal(0, snapshot.EstimatedUtf8Bytes);
        Assert.Equal(0, snapshot.AuthorizationBytes);
        Assert.Equal(0, snapshot.CookieBytes);
    }

    [Fact]
    public void Inspect_CountsHeadersAndValues()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Test"] = new[] { "a", "b" };
        context.Request.Headers["Accept"] = "application/json";

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.Equal(2, snapshot.HeaderCount);
        Assert.Equal(3, snapshot.HeaderValueCount);
        Assert.True(snapshot.EstimatedUtf8Bytes > 0);
    }

    [Fact]
    public void Inspect_TracksSensitiveHeaderSizesWithoutRetainingValues()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers.Authorization = "Bearer abcdef";
        context.Request.Headers.Cookie = "session=123456";
        context.Request.Headers.ContentType = "application/json";
        context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.Equal("Bearer abcdef".Length, snapshot.AuthorizationBytes);
        Assert.Equal("session=123456".Length, snapshot.CookieBytes);
        Assert.Equal("application/json".Length, snapshot.ContentTypeBytes);
        Assert.Equal("127.0.0.1".Length, snapshot.ForwardedForBytes);
    }

    [Fact]
    public void Inspect_UsesUtf8ByteLength()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Culture"] = "İstanbul";

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.True(snapshot.EstimatedUtf8Bytes > "X-Cultureİstanbul".Length);
    }

    [Fact]
    public void GetHeaderUtf8Length_MissingHeader_ReturnsZero()
    {
        var context = new DefaultHttpContext();

        Assert.Equal(0, RequestHeaderInspector.GetHeaderUtf8Length(
            context.Request.Headers,
            "Authorization"));
    }

    [Fact]
    public void GetHeaderUtf8Length_MultiValue_IncludesSeparatorEstimate()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Values"] = new[] { "a", "bb" };

        Assert.Equal(5, RequestHeaderInspector.GetHeaderUtf8Length(
            context.Request.Headers,
            "X-Values"));
    }

    [Fact]
    public void ContainsNewline_DetectsCarriageReturn()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Test"] = "safe\runsafe";

        Assert.True(RequestHeaderInspector.ContainsNewline(context.Request.Headers));
    }

    [Fact]
    public void ContainsNewline_DetectsLineFeed()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Test"] = "safe\nunsafe";

        Assert.True(RequestHeaderInspector.ContainsNewline(context.Request.Headers));
    }

    [Fact]
    public void ContainsNewline_ReturnsFalseForOrdinaryHeaders()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Test"] = "safe-value";

        Assert.False(RequestHeaderInspector.ContainsNewline(context.Request.Headers));
    }

    [Fact]
    public void Inspect_ThrowsForNullHeaders()
    {
        Assert.Throws<ArgumentNullException>(() => RequestHeaderInspector.Inspect(null!));
    }

    [Fact]
    public void VeryLargeHeader_ProducesLargeButFiniteEstimate()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Large"] = new string('x', 100_000);

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.True(snapshot.EstimatedUtf8Bytes >= 100_000);
        Assert.True(snapshot.EstimatedUtf8Bytes < long.MaxValue);
    }

    [Fact]
    public void HeaderNameBytes_AreIncludedInTotal()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Long-Header-Name"] = "a";

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.True(snapshot.EstimatedUtf8Bytes > 1);
    }
}
