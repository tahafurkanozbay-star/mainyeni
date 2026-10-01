using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestFramingGovernanceTests
{
    [Fact]
    public void Inspector_AbsentFramingHeaders_ReturnsAbsentStates()
    {
        var snapshot = RequestFramingInspector.Inspect(CreateContext().Request.Headers);

        Assert.Equal(RequestContentLengthState.Absent, snapshot.ContentLengthState);
        Assert.Null(snapshot.ContentLength);
        Assert.Equal(RequestTransferEncodingState.Absent, snapshot.TransferEncodingState);
        Assert.Equal(0, snapshot.TransferCodingCount);
        Assert.Equal(0, snapshot.ContentTypeValueCount);
        Assert.False(snapshot.HasContentLength);
        Assert.False(snapshot.HasTransferEncoding);
        Assert.False(snapshot.UsesChunkedTransferEncoding);
    }

    [Theory]
    [InlineData("0", 0L)]
    [InlineData("1", 1L)]
    [InlineData("000001", 1L)]
    [InlineData(" 42 ", 42L)]
    [InlineData("\t42\t", 42L)]
    [InlineData("9223372036854775807", long.MaxValue)]
    public void Inspector_ParsesSingleDecimalContentLength(string raw, long expected)
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestContentLengthState.Valid, snapshot.ContentLengthState);
        Assert.Equal(expected, snapshot.ContentLength);
        Assert.True(snapshot.HasContentLength);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("\t")]
    [InlineData("+1")]
    [InlineData("-1")]
    [InlineData("1.0")]
    [InlineData("0x10")]
    [InlineData("1 0")]
    [InlineData("1\t0")]
    [InlineData("abc")]
    [InlineData("9223372036854775808")]
    public void Inspector_RejectsInvalidContentLength(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestContentLengthState.Invalid, snapshot.ContentLengthState);
        Assert.Null(snapshot.ContentLength);
    }

    [Theory]
    [InlineData("10,10")]
    [InlineData("10, 10")]
    [InlineData("10,20")]
    [InlineData(",10")]
    [InlineData("10,")]
    public void Inspector_RejectsCommaCombinedContentLengthAsMultiple(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestContentLengthState.Multiple, snapshot.ContentLengthState);
        Assert.Null(snapshot.ContentLength);
    }

    [Fact]
    public void Inspector_RejectsMultipleContentLengthFieldValues()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = new[] { "10", "10" };

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestContentLengthState.Multiple, snapshot.ContentLengthState);
    }

    [Theory]
    [InlineData("chunked")]
    [InlineData("Chunked")]
    [InlineData(" CHUNKED ")]
    [InlineData("\tchunked\t")]
    public void Inspector_AcceptsSingleChunkedTransferCoding(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Transfer-Encoding"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestTransferEncodingState.Chunked, snapshot.TransferEncodingState);
        Assert.Equal(1, snapshot.TransferCodingCount);
        Assert.True(snapshot.HasTransferEncoding);
        Assert.True(snapshot.UsesChunkedTransferEncoding);
    }

    [Theory]
    [InlineData("gzip")]
    [InlineData("identity")]
    [InlineData("compress")]
    [InlineData("chunked;foo=bar")]
    [InlineData("gzip;level=1")]
    public void Inspector_RejectsUnsupportedTransferCoding(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Transfer-Encoding"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestTransferEncodingState.Unsupported, snapshot.TransferEncodingState);
        Assert.Equal(1, snapshot.TransferCodingCount);
    }

    [Theory]
    [InlineData("gzip, chunked")]
    [InlineData("chunked, gzip")]
    [InlineData("chunked, chunked")]
    [InlineData("gzip, deflate, chunked")]
    public void Inspector_RejectsMultipleTransferCodings(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Transfer-Encoding"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestTransferEncodingState.Multiple, snapshot.TransferEncodingState);
        Assert.True(snapshot.TransferCodingCount > 1);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(",")]
    [InlineData(",chunked")]
    [InlineData("chunked,")]
    [InlineData("chunked,,gzip")]
    public void Inspector_RejectsMalformedTransferEncoding(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Transfer-Encoding"] = raw;

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestTransferEncodingState.Invalid, snapshot.TransferEncodingState);
    }

    [Fact]
    public void Inspector_TracksMultipleRawTransferEncodingFieldValues()
    {
        var context = CreateContext();
        context.Request.Headers["Transfer-Encoding"] = new[] { "gzip", "chunked" };

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);

        Assert.Equal(RequestTransferEncodingState.Multiple, snapshot.TransferEncodingState);
        Assert.Equal(2, snapshot.TransferCodingCount);
    }

    [Fact]
    public void Inspector_TracksContentTypeFieldValueCountWithoutRetainingValues()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Type"] = new[]
        {
            "application/json",
            "application/xml"
        };

        var snapshot = RequestFramingInspector.Inspect(context.Request.Headers);
        var representation = snapshot.ToString();

        Assert.Equal(2, snapshot.ContentTypeValueCount);
        Assert.DoesNotContain("application/json", representation, StringComparison.Ordinal);
        Assert.DoesNotContain("application/xml", representation, StringComparison.Ordinal);
    }

    [Fact]
    public void Inspector_ThrowsForNullHeaders()
    {
        Assert.Throws<ArgumentNullException>(() => RequestFramingInspector.Inspect(null!));
    }

    [Fact]
    public void HeaderInspector_TracksSecuritySensitiveHeaderValueCounts()
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
    public void Evaluator_AmbiguousFramingPrecedesIndividualValueValidation()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = "invalid";
        context.Request.Headers["Transfer-Encoding"] = "gzip";

        var decision = Evaluate(context);

        Assert.Equal("ambiguous-body-framing", decision.Code);
    }

    [Theory]
    [InlineData("10,10")]
    [InlineData("10, 20")]
    public void Evaluator_RejectsCombinedMultipleContentLengthValues(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = raw;

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("multiple-content-length", decision.Code);
    }

    [Fact]
    public void Evaluator_RejectsMultipleContentLengthFieldValues()
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = new[] { "10", "10" };

        var decision = Evaluate(context);

        Assert.Equal("multiple-content-length", decision.Code);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("+1")]
    [InlineData("1.5")]
    [InlineData("9223372036854775808")]
    public void Evaluator_RejectsInvalidContentLength(string raw)
    {
        var context = CreateContext();
        context.Request.Headers["Content-Length"] = raw;

        var decision = Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("invalid-content-length", decision.Code);
    }

    [Theory]
    [InlineData("gzip, chunked", "multiple-transfer-codings")]
    [InlineData("chunked, chunked", "multiple-transfer-codings")]
    [InlineData("gzip", "unsupported-transfer-coding")]
    [InlineData("chunked;foo=bar", "unsupported-transfer-coding")]
    [InlineData("chunked,", "invalid-transfer-encoding")]
    public void Evaluator_RejectsUnsupportedOrAmbiguousTransferEncoding(
        string raw,
        string expectedCode)
    {
        var context = CreateContext();
        context.Request.Headers["Transfer-Encoding"] = raw;

        var decision = Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal(expectedCode, decision.Code);
    }

    [Fact]
    public void Evaluator_RejectsMultipleContentTypeFieldValues()
    {
        var context = CreateContext();
        context.Request.Method = "POST";
        context.Request.Headers["Content-Length"] = "10";
        context.Request.Headers["Content-Type"] = new[]
        {
            "application/json",
            "application/xml"
        };

        var decision = Evaluate(context);

        Assert.Equal(StatusCodes.Status400BadRequest, decision.StatusCode);
        Assert.Equal("multiple-content-type-values", decision.Code);
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
