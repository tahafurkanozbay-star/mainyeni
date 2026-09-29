using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestTargetGovernanceHardeningTests
{
    [Theory]
    [InlineData("/api/%252e%252e/secret")]
    [InlineData("/api/%25252e%25252e/secret")]
    [InlineData("/api/%25%32%65%25%32%65/secret")]
    [InlineData("/api/.%252e/secret")]
    [InlineData("/api/%2e%252e/secret")]
    public void Evaluate_NestedTraversal_IsRejected(string target)
    {
        var decision = CreateEvaluator().Evaluate(CreateContext(target));

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("path-traversal", decision.Code);
    }

    [Theory]
    [InlineData("/api/%252fsecret")]
    [InlineData("/api/%25252Fsecret")]
    [InlineData("/api/%25%32%66secret")]
    [InlineData("/api/%25%35%43secret")]
    public void Evaluate_NestedEncodedSeparators_AreRejected(string target)
    {
        var decision = CreateEvaluator().Evaluate(CreateContext(target));

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("encoded-path-separator", decision.Code);
    }

    [Fact]
    public void Evaluate_ExcessivePercentEncodingDepth_FailsClosed()
    {
        var target = NestPercentEncoding("/api/%41nkara", 10);

        var decision = CreateEvaluator().Evaluate(CreateContext(target));

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("path-encoding-depth-exceeded", decision.Code);
    }

    [Fact]
    public void Evaluate_EncodingDepthAtSafeBound_RemainsAllowedWhenBenign()
    {
        var target = NestPercentEncoding("/api/%41nkara", 6);

        var decision = CreateEvaluator().Evaluate(CreateContext(target));

        Assert.True(decision.Allowed);
    }

    [Fact]
    public void Evaluate_DeepEncodingInsideQuery_RemainsQueryData()
    {
        var queryValue = NestPercentEncoding("%2f", 12);

        var decision = CreateEvaluator().Evaluate(
            CreateContext("/api/search?q=" + queryValue));

        Assert.True(decision.Allowed);
    }

    [Fact]
    public void Evaluate_DepthGuardCanBeDisabledWithBothNormalizationPolicies()
    {
        var options = new ApiPlatformOptions();
        options.Governance.RejectPathTraversal = false;
        options.Governance.RejectEncodedPathSeparators = false;
        var evaluator = new RequestGovernanceEvaluator(options);
        var target = NestPercentEncoding("/api/%41nkara", 10);

        var decision = evaluator.Evaluate(CreateContext(target));

        Assert.True(decision.Allowed);
    }

    [Fact]
    public void Evaluate_DepthGuardRemainsActiveWhenTraversalPolicyIsEnabled()
    {
        var options = new ApiPlatformOptions();
        options.Governance.RejectPathTraversal = true;
        options.Governance.RejectEncodedPathSeparators = false;
        var evaluator = new RequestGovernanceEvaluator(options);
        var target = NestPercentEncoding("/api/%41nkara", 10);

        var decision = evaluator.Evaluate(CreateContext(target));

        Assert.Equal("path-encoding-depth-exceeded", decision.Code);
    }

    [Fact]
    public void Evaluate_DepthGuardRemainsActiveWhenSeparatorPolicyIsEnabled()
    {
        var options = new ApiPlatformOptions();
        options.Governance.RejectPathTraversal = false;
        options.Governance.RejectEncodedPathSeparators = true;
        var evaluator = new RequestGovernanceEvaluator(options);
        var target = NestPercentEncoding("/api/%41nkara", 10);

        var decision = evaluator.Evaluate(CreateContext(target));

        Assert.Equal("path-encoding-depth-exceeded", decision.Code);
    }

    [Fact]
    public void DisabledGovernance_DoesNotApplyDepthGuard()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        var evaluator = new RequestGovernanceEvaluator(options);
        var target = NestPercentEncoding("/api/%2e%2e/secret", 10);

        Assert.True(evaluator.Evaluate(CreateContext(target)).Allowed);
    }

    private static RequestGovernanceEvaluator CreateEvaluator()
    {
        return new RequestGovernanceEvaluator(new ApiPlatformOptions());
    }

    private static DefaultHttpContext CreateContext(string rawTarget)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        var queryIndex = rawTarget.IndexOf('?');
        context.Request.Path = queryIndex >= 0 ? rawTarget[..queryIndex] : rawTarget;
        context.Request.QueryString = queryIndex >= 0
            ? new QueryString(rawTarget[queryIndex..])
            : QueryString.Empty;

        var feature = context.Features.Get<IHttpRequestFeature>();
        if (feature != null)
        {
            feature.RawTarget = rawTarget;
        }

        return context;
    }

    private static string NestPercentEncoding(string value, int levels)
    {
        var result = value;
        for (var level = 0; level < levels; level++)
        {
            result = result.Replace("%", "%25", System.StringComparison.Ordinal);
        }

        return result;
    }
}
