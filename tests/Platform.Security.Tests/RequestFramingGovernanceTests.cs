using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestFramingGovernanceTests
{
    [Fact]
    public void HeaderInspector_TracksFramingHeaderValueCounts()
    {
        var context = CreateContext();
        context.Request.Headers["Authorization"] = new[] { "Bearer a", "Bearer b" };
        context.Request.Headers["Content-Length"] = "10";
        context.Request.Headers["Transfer-Encoding"] = "chunked";
        context.Request.Headers["Host"] = "example.test";

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.Equal(2, snapshot.AuthorizationValueCount);
        Assert.Equal(1, snapshot.ContentLengthValueCount);
        Assert.Equal(1, snapshot.TransferEncodingValueCount);
        Assert.Equal(1, snapshot.HostValueCount);
    }

    [Fact]
    public void HeaderInspector_MissingFramingHeadersHaveZeroCounts()
    {
        var context = CreateContext();

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);

        Assert.Equal(0, snapshot.AuthorizationValueCount);
        Assert.Equal(0, snapshot.ContentLengthValueCount);
        Assert.Equal(0, snapshot.TransferEncodingValueCount);
        Assert.Equal(0, snapshot.HostValueCount);
    }

    [Fact]
    public void GetHeaderValueCount_HandlesMissingHeader()
    {
        var context = CreateContext();

        Assert.Equal(
            0,
            RequestHeaderInspector.GetHeaderValueCount(
                context.Request.Headers,
                "Authorization"));
    }

    [Fact]
    public void GetHeaderValueCount_HandlesMultipleValues()
    {
        var context = CreateContext();
        context.Request.Headers["X-Test"] = new[] { "a", "b", "c" };

        Assert.Equal(
            3,
            RequestHeaderInspector.GetHeaderValueCount(
                context.Request.Headers,
                "X-Test"));
    }

    [Fact]
    public void Evaluator_RejectsContentLengthAndTransferEncodingTogether()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = "10";
        context.Request.Headers["Transfer-Encoding"] = "chunked";

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("ambiguous-body-framing", decision.Code);
    }

    [Fact]
    public void Evaluator_RejectsMultipleContentLengthValues()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = new[] { "10", "10" };

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("multiple-content-length", decision.Code);
    }

    [Fact]
    public void Evaluator_RejectsConflictingMultipleContentLengthValues()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = new[] { "10", "20" };

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal("multiple-content-length", decision.Code);
    }

    [Fact]
    public void Evaluator_RejectsMultipleAuthorizationValues()
    {
        var context = CreateContext();
        context.Request.Headers["Authorization"] = new[]
        {
            "Bearer first",
            "Bearer second"
        };

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("multiple-authorization-values", decision.Code);
    }

    [Fact]
    public void Evaluator_RejectsMultipleHostValues()
    {
        var context = CreateContext();
        context.Request.Headers["Host"] = new[]
        {
            "public.example",
            "admin.example"
        };

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("multiple-host-values", decision.Code);
    }

    [Fact]
    public void Evaluator_AllowsSingleContentLength()
    {
        var context = CreateContext();
        context.Request.Method = "POST";
        context.Request.Headers["Content-Length"] = "10";
        context.Request.ContentType = "application/json";

        var decision = Evaluate(context);

        Assert.True(decision.Allowed);
    }

    [Fact]
    public void Evaluator_AllowsSingleChunkedTransferEncodingWithKnownContentType()
    {
        var context = CreateContext();
        context.Request.Method = "POST";
        context.Request.Headers["Transfer-Encoding"] = "chunked";
        context.Request.ContentType = "application/json";

        var decision = Evaluate(context);

        Assert.True(decision.Allowed);
    }

    [Fact]
    public void Evaluator_AllowsSingleAuthorizationValue()
    {
        var context = CreateContext();
        context.Request.Headers.Authorization = "Bearer token";

        Assert.True(Evaluate(context).Allowed);
    }

    [Fact]
    public void Evaluator_AllowsSingleHostValue()
    {
        var context = CreateContext();
        context.Request.Headers.Host = "api.example";

        Assert.True(Evaluate(context).Allowed);
    }

    [Fact]
    public void FramingRejection_DoesNotEchoHeaderValues()
    {
        var context = CreateContext();
        context.Request.Headers["Authorization"] = new[]
        {
            "Bearer secret-one",
            "Bearer secret-two"
        };

        var decision = Evaluate(context);

        Assert.DoesNotContain("secret-one", decision.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-two", decision.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("Bearer", decision.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void FramingChecks_RunBeforeAggregateHeaderBudget()
    {
        var options = new ApiPlatformOptions();
        options.Governance.MaxHeaderBytes = 4096;
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = new[] { "10", "10" };
        context.Request.Headers["X-Large"] = new string('x', 5000);

        var decision = evaluator.Evaluate(context);

        Assert.Equal("multiple-content-length", decision.Code);
    }

    [Fact]
    public void AmbiguousBodyFraming_IsRejectedBeforeContentTypePolicy()
    {
        var context = CreateContext();
        context.Request.Method = "POST";
        context.Request.Headers["Content-Length"] = "10";
        context.Request.Headers["Transfer-Encoding"] = "chunked";
        context.Request.ContentType = "application/xml";

        var decision = Evaluate(context);

        Assert.Equal("ambiguous-body-framing", decision.Code);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
    }

    [Fact]
    public void DuplicateAuthorization_IsRejectedForGetRequestsToo()
    {
        var context = CreateContext();
        context.Request.Method = "GET";
        context.Request.Headers["Authorization"] = new[] { "a", "b" };

        var decision = Evaluate(context);

        Assert.Equal("multiple-authorization-values", decision.Code);
    }

    [Fact]
    public void HeaderValueCounter_ReturnsZeroForBlankHeaderName()
    {
        var context = CreateContext();

        Assert.Equal(
            0,
            RequestHeaderInspector.GetHeaderValueCount(
                context.Request.Headers,
                "  "));
    }

    [Fact]
    public void FramingSnapshot_DoesNotContainSensitiveValues()
    {
        var context = CreateContext();
        context.Request.Headers.Authorization = "Bearer should-never-be-stored";
        context.Request.Headers.Host = "sensitive.example";

        var snapshot = RequestHeaderInspector.Inspect(context.Request.Headers);
        var representation = snapshot.ToString();

        Assert.DoesNotContain("should-never-be-stored", representation, StringComparison.Ordinal);
        Assert.DoesNotContain("sensitive.example", representation, StringComparison.Ordinal);
    }

    private static RequestGovernanceDecision Evaluate(DefaultHttpContext context)
    {
        return new RequestGovernanceEvaluator(new ApiPlatformOptions())
            .Evaluate(context);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Path = "/api/items";
        return context;
    }
}
