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
    [InlineData("/api/%252e%252e/secret", "path-traversal")]
    [InlineData("/api/%25252e%25252e/secret", "path-traversal")]
    [InlineData("/api/%2fsecret", "encoded-path-separator")]
    [InlineData("/api/%25252fsecret", "encoded-path-separator")]
    [InlineData("/api\\secret", "backslash-in-path")]
    public void Evaluate_RejectsAmbiguousOrTraversalPaths(string target, string expectedCode)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", target);

        var decision = evaluator.Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal(expectedCode, decision.Code);
    }

    [Theory]
    [InlineData("/api/%")]
    [InlineData("/api/%2")]
    [InlineData("/api/%GG")]
    [InlineData("/api/%25GG")]
    public void Evaluate_RejectsMalformedPathPercentEncoding(string target)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", target);

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("invalid-path-encoding", decision.Code);
    }

    [Theory]
    [InlineData("/api/%00value")]
    [InlineData("/api/%09value")]
    [InlineData("/api/%1fvalue")]
    [InlineData("/api/%7fvalue")]
    [InlineData("/api/%2500value")]
    public void Evaluate_RejectsEncodedControlCharacters(string target)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", target);

        var decision = evaluator.Evaluate(context);

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

        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/" + nested + "/secret");

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("excessive-path-encoding", decision.Code);
    }

    [Fact]
    public void Evaluate_DoesNotRejectEncodedSeparatorsInsideQuery()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/search?q=%25252Fankara%25252F");

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluate_DoesNotRejectMalformedPercentInsideQuery()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", "/api/search?q=%GG");

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    [Theory]
    [InlineData("/api/%20space")]
    [InlineData("/api/%7Etilde")]
    [InlineData("/api/%41value")]
    [InlineData("/api/%C4%B0stanbul")]
    public void Evaluate_AllowsOrdinaryPercentEncodedPathData(string target)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("GET", target);

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

    [Theory]
    [InlineData("10,10", "multiple-content-length")]
    [InlineData("10, 20", "multiple-content-length")]
    [InlineData("-1", "invalid-content-length")]
    [InlineData("+1", "invalid-content-length")]
    [InlineData("1.5", "invalid-content-length")]
    [InlineData("9223372036854775808", "invalid-content-length")]
    public void Evaluate_RejectsInvalidContentLengthRepresentations(
        string raw,
        string expectedCode)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.Headers["Content-Length"] = raw;
        context.Request.ContentType = "application/json";

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal(expectedCode, decision.Code);
    }

    [Theory]
    [InlineData("gzip", "unsupported-transfer-coding")]
    [InlineData("identity", "unsupported-transfer-coding")]
    [InlineData("chunked;foo=bar", "unsupported-transfer-coding")]
    [InlineData("gzip, chunked", "multiple-transfer-codings")]
    [InlineData("chunked, chunked", "multiple-transfer-codings")]
    [InlineData("chunked,", "invalid-transfer-encoding")]
    public void Evaluate_RejectsInvalidTransferEncodingRepresentations(
        string raw,
        string expectedCode)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.Headers["Transfer-Encoding"] = raw;
        context.Request.ContentType = "application/json";

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal(expectedCode, decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsContentLengthAndTransferEncodingTogetherBeforeBodyPolicy()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.Headers["Content-Length"] = "10";
        context.Request.Headers["Transfer-Encoding"] = "chunked";
        context.Request.ContentType = "application/xml";

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("ambiguous-body-framing", decision.Code);
    }

    [Fact]
    public void Evaluate_RejectsMultipleContentTypeValuesBeforeBodyPolicy()
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.Headers["Content-Length"] = "10";
        context.Request.Headers["Content-Type"] = new[]
        {
            "application/json",
            "application/xml"
        };

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("multiple-content-type-values", decision.Code);
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

    [Theory]
    [InlineData("not-a-media-type")]
    [InlineData("application/")]
    [InlineData("application/*")]
    [InlineData("application/json, application/xml")]
    public void Evaluate_RejectsMalformedBodyContentType(string contentType)
    {
        var evaluator = CreateEvaluator();
        var context = CreateContext("POST", "/api/items");
        context.Request.ContentLength = 10;
        context.Request.ContentType = contentType;

        var decision = evaluator.Evaluate(context);

        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, decision.StatusCode);
        Assert.Equal("malformed-content-type", decision.Code);
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
        var context = CreateContext("TRACE", "/api/%GG/../secret");

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
