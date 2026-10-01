using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using System;
using Xunit;

namespace Platform.Security.Tests;

/// <summary>
/// Exercises raw request-target governance without routing test input through PathString decoding.
/// RawTarget is the authority that Kestrel exposes for pre-routing security checks; Request.Path is
/// deliberately kept as a safe fixture path so encoded controls such as %00 reach the evaluator.
/// </summary>
public sealed class RequestTargetGovernanceRegressionTests
{
    [Theory]
    [InlineData("/api/../secret", "path-traversal")]
    [InlineData("/api/%2e%2e/secret", "path-traversal")]
    [InlineData("/api/%252e%252e/secret", "path-traversal")]
    [InlineData("/api/%25252e%25252e/secret", "path-traversal")]
    [InlineData("/api/%2fsecret", "encoded-path-separator")]
    [InlineData("/api/%25252fsecret", "encoded-path-separator")]
    [InlineData("/api\\secret", "backslash-in-path")]
    public void Evaluate_RejectsAmbiguousOrTraversalPaths(string rawTarget, string expectedCode)
    {
        var decision = Evaluate(rawTarget);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal(expectedCode, decision.Code);
    }

    [Theory]
    [InlineData("/api/%")]
    [InlineData("/api/%2")]
    [InlineData("/api/%GG")]
    [InlineData("/api/%25GG")]
    public void Evaluate_RejectsMalformedPercentEncoding(string rawTarget)
    {
        var decision = Evaluate(rawTarget);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("invalid-path-encoding", decision.Code);
    }

    [Theory]
    [InlineData("/api/%00value")]
    [InlineData("/api/%09value")]
    [InlineData("/api/%1fvalue")]
    [InlineData("/api/%7fvalue")]
    [InlineData("/api/%2500value")]
    public void Evaluate_RejectsEncodedControlCharactersWithoutPathStringNormalization(string rawTarget)
    {
        var decision = Evaluate(rawTarget);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("request-target-control-character", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsExcessiveNestedReservedEncoding()
    {
        var nested = "%2e%2e";
        for (var index = 0; index < 10; index++)
        {
            nested = nested.Replace("%", "%25", StringComparison.Ordinal);
        }

        var decision = Evaluate("/api/" + nested + "/secret");

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("excessive-path-encoding", decision.Code);
    }

    [Theory]
    [InlineData("/api/search?q=%25252Fankara%25252F")]
    [InlineData("/api/search?q=%GG")]
    public void Evaluate_DoesNotApplyPathCanonicalizationRulesToQueryValues(string rawTarget)
    {
        Assert.True(Evaluate(rawTarget).Allowed);
    }

    [Theory]
    [InlineData("/api/%20space")]
    [InlineData("/api/%7Etilde")]
    [InlineData("/api/%41value")]
    [InlineData("/api/%C4%B0stanbul")]
    public void Evaluate_AllowsOrdinaryPercentEncodedPathData(string rawTarget)
    {
        Assert.True(Evaluate(rawTarget).Allowed);
    }

    [Fact]
    public void Inspector_BoundsPercentDecodePasses()
    {
        var nested = "%2f";
        for (var index = 0; index < 20; index++)
        {
            nested = nested.Replace("%", "%25", StringComparison.Ordinal);
        }

        var snapshot = RequestTargetInspector.Inspect("/api/" + nested);

        Assert.Equal(8, snapshot.PercentDecodePassCount);
        Assert.True(snapshot.ContainsOverEncodedReservedSequence);
    }

    [Fact]
    public void Inspector_DoesNotTreatQueryEncodedSeparatorAsPathSeparator()
    {
        var snapshot = RequestTargetInspector.Inspect("/api/search?q=%252fankara");

        Assert.False(snapshot.ContainsEncodedSeparator);
        Assert.False(snapshot.ContainsEncodedTraversal);
    }

    [Fact]
    public void Inspector_ReportsRawTargetAndQueryBudgetsFromOriginalRepresentation()
    {
        const string rawTarget = "/api/search?q=%252e%252e&district=ankara";

        var snapshot = RequestTargetInspector.Inspect(rawTarget);

        Assert.Equal(rawTarget.Length, snapshot.RawTargetLength);
        Assert.Equal("/api/search".Length, snapshot.PathLength);
        Assert.Equal("q=%252e%252e&district=ankara".Length, snapshot.QueryLength);
        Assert.Equal(2, snapshot.QueryParameterCount);
    }

    private static RequestGovernanceDecision Evaluate(string rawTarget)
    {
        var evaluator = new RequestGovernanceEvaluator(new ApiPlatformOptions());
        return evaluator.Evaluate(CreateContext(rawTarget));
    }

    private static DefaultHttpContext CreateContext(string rawTarget)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/__raw-target-regression__";

        var feature = context.Features.Get<IHttpRequestFeature>();
        if (feature == null)
        {
            throw new InvalidOperationException("DefaultHttpContext must expose IHttpRequestFeature.");
        }

        feature.RawTarget = rawTarget;
        return context;
    }
}
