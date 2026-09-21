using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestGovernanceEvaluatorTests
{
    [Fact]
    public void Evaluate_DefaultGetRequest_IsAllowed()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/items");

        var decision = evaluator.Evaluate(context);

        Assert.True(decision.Allowed);
    }

    [Theory]
    [InlineData("TRACE")]
    [InlineData("CONNECT")]
    public void Evaluate_DangerousMethods_AreRejected(string method)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext(method, "/api/items");

        var decision = evaluator.Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status405MethodNotAllowed, decision.StatusCode);
        Assert.Equal("method-not-allowed", decision.Code);
    }

    [Fact]
    public void Evaluate_DangerousMethodsCanBeExplicitlyAllowed()
    {
        var options = new ApiPlatformOptions();
        options.Governance.RejectTraceAndConnect = false;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("TRACE", "/api/items");

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluate_RejectsRawTargetAboveBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxRawTargetChars = 256;
        options.Governance.MaxPathChars = 256;
        options.Governance.MaxQueryStringChars = 0;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/" + new string('a', 300));

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status414UriTooLong, decision.StatusCode);
        Assert.Equal("raw-target-too-long", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsPathAboveBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxRawTargetChars = 1000;
        options.Governance.MaxPathChars = 128;
        options.Governance.MaxQueryStringChars = 500;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/" + new string('p', 200));

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status414UriTooLong, decision.StatusCode);
        Assert.Equal("path-too-long", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsQueryAboveBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxRawTargetChars = 1000;
        options.Governance.MaxPathChars = 128;
        options.Governance.MaxQueryStringChars = 10;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/api?q=" + new string('x', 20));

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status414UriTooLong, decision.StatusCode);
        Assert.Equal("query-too-long", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsTooManyQueryParameters()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxQueryParameters = 2;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/api?a=1&b=2&c=3");

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("too-many-query-parameters", decision.Code);
    }

    [Theory]
    [InlineData("/api/../secret", "path-traversal")]
    [InlineData("/api/%2e%2e/secret", "path-traversal")]
    [InlineData("/api/%2fsecret", "encoded-path-separator")]
    [InlineData("/api\\secret", "backslash-in-path")]
    public void Evaluate_RejectsAmbiguousOrTraversalPaths(string target, string expectedCode)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", target);

        var decision = evaluator.Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(expectedCode, decision.Code);
    }

    [Fact]
    public void Evaluate_DoesNotRejectEncodedSeparatorsInsideQuery()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/search?q=%2Fankara%2F");

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluate_RejectsHeaderCountAboveBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderCount = 8;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/api");

        for (var index = 0; index < 9; index++)
        {
            context.Request.Headers["X-Test-" + index] = "a";
        }

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status431RequestHeaderFieldsTooLarge, decision.StatusCode);
        Assert.Equal("too-many-headers", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsHeaderBytesAboveBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 4096;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/api");
        context.Request.Headers["X-Large"] = new string('x', 5000);

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status431RequestHeaderFieldsTooLarge, decision.StatusCode);
        Assert.Equal("headers-too-large", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsOversizedAuthorizationHeaderIndependently()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 32000;
        options.Governance.MaxAuthorizationHeaderBytes = 256;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/api");
        context.Request.Headers.Authorization = "Bearer " + new string('x', 300);

        var decision = evaluator.Evaluate(context);

        Assert.Equal("authorization-header-too-large", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsOversizedCookieHeaderIndependently()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 32000;
        options.Governance.MaxCookieHeaderBytes = 256;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("GET", "/api");
        context.Request.Headers.Cookie = "session=" + new string('x', 300);

        var decision = evaluator.Evaluate(context);

        Assert.Equal("cookie-header-too-large", decision.Code);
    }

    [Fact]
    public void Evaluate_RequiresContentTypeForBodyRequests()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.ContentLength = 10;

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, decision.StatusCode);
        Assert.Equal("content-type-required", decision.Code);
    }

    [Fact]
    public void Evaluate_AcceptsConfiguredJsonContentType()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.ContentLength = 10;
        context.Request.ContentType = "application/json; charset=utf-8";

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluate_AcceptsVendorJsonThroughStructuredSuffixWildcard()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("PATCH", "/api/items/1");
        context.Request.ContentLength = 10;
        context.Request.ContentType = "application/vnd.kentrehberi.item+json";

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluate_RejectsUnsupportedBodyContentType()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.ContentLength = 10;
        context.Request.ContentType = "application/xml";

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, decision.StatusCode);
        Assert.Equal("unsupported-content-type", decision.Code);
    }

    [Fact]
    public void Evaluate_GetWithContentLength_DoesNotRequireBodyContentType()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/items");
        context.Request.ContentLength = 10;

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void DisabledGovernance_AllowsOtherwiseInvalidRequest()
    {
        var options = new ApiPlatformOptions();
        options.Governance.Enabled = false;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext("TRACE", "/api/../secret");

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void ShouldBypassConcurrency_ExemptsOptionsByDefault()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("OPTIONS", "/api/items");

        Assert.True(evaluator.ShouldBypassConcurrency(context));
    }

    [Fact]
    public void ShouldBypassConcurrency_ExemptsHealthByDefault()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/health/live");

        Assert.True(evaluator.ShouldBypassConcurrency(context));
    }

    [Fact]
    public void ShouldBypassConcurrency_DoesNotExemptNormalApiRequest()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/items");

        Assert.False(evaluator.ShouldBypassConcurrency(context));
    }

    [Fact]
    public void Evaluate_ThrowsForNullContext()
    {
        var evaluator = CreateEvaluator();

        Assert.Throws<ArgumentNullException>(() => evaluator.Evaluate(null!));
    }

    private static RequestGovernanceEvaluator CreateEvaluator()
    {
        return new RequestGovernanceEvaluator(new ApiPlatformOptions());
    }

    private static DefaultHttpContext CreateContext(string method, string rawTarget)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;

        var queryIndex = rawTarget.IndexOf('?');
        var path = queryIndex >= 0 ? rawTarget[..queryIndex] : rawTarget;
        var query = queryIndex >= 0 ? rawTarget[queryIndex..] : string.Empty;
        context.Request.Path = path;
        context.Request.QueryString = new QueryString(query);

        var feature = context.Features.Get<IHttpRequestFeature>();
        if (feature != null)
        {
            feature.RawTarget = rawTarget;
        }

        return context;
    }
}
