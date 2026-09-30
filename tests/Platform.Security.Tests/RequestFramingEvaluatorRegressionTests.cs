using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestFramingEvaluatorRegressionTests
{
    [Theory]
    [InlineData("-1")]
    [InlineData("+1")]
    [InlineData("1, 1")]
    [InlineData("abc")]
    public void Evaluator_RejectsInvalidContentLengthBeforeContentPolicy(string value)
    {
        var context = Create();
        context.Request.Headers["Content-Length"] = value;
        context.Request.ContentType = "application/json";
        var decision = Evaluate(context);
        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("invalid-content-length", decision.Code);
    }

    [Theory]
    [InlineData("gzip")]
    [InlineData("chunked, gzip")]
    [InlineData("gzip, chunked")]
    public void Evaluator_RejectsUnsupportedTransferCoding(string value)
    {
        var context = Create();
        context.Request.Headers["Transfer-Encoding"] = value;
        context.Request.ContentType = "application/json";
        var decision = Evaluate(context);
        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("unsupported-transfer-encoding", decision.Code);
    }

    [Fact]
    public void Evaluator_AcceptsCanonicalContentLength()
    {
        var context = Create();
        context.Request.Headers["Content-Length"] = "10";
        context.Request.ContentType = "application/json";
        Assert.True(Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluator_AcceptsSingleChunkedTransferCoding()
    {
        var context = Create();
        context.Request.Headers["Transfer-Encoding"] = "chunked";
        context.Request.ContentType = "application/json";
        Assert.True(Evaluate(context).Allowed);
    }

    [Fact]
    public void AmbiguousLengthAndTransferCodingStillHasHighestPriority()
    {
        var context = Create();
        context.Request.Headers["Content-Length"] = "invalid";
        context.Request.Headers["Transfer-Encoding"] = "gzip";
        var decision = Evaluate(context);
        Assert.Equal("ambiguous-body-framing", decision.Code);
    }

    private static DefaultHttpContext Create()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.Path = "/api/items";
        return context;
    }

    private static RequestGovernanceDecision Evaluate(DefaultHttpContext context)
        => new RequestGovernanceEvaluator(new ApiPlatformOptions()).Evaluate(context);
}
