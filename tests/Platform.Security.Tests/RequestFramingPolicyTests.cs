using Api.Core.Platform.Governance;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestFramingPolicyTests
{
    [Theory]
    [InlineData("0")]
    [InlineData("1")]
    [InlineData("1048576")]
    [InlineData("9223372036854775807")]
    public void ContentLength_AcceptsCanonicalNonNegativeDecimal(string value)
        => Assert.True(RequestFramingPolicy.ValidateContentLength(new StringValues(value)).IsValid);

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("-1")]
    [InlineData("+1")]
    [InlineData("1,1")]
    [InlineData("1.0")]
    [InlineData("18446744073709551615")]
    [InlineData("abc")]
    public void ContentLength_RejectsAmbiguousOrInvalidForms(string value)
    {
        var result = RequestFramingPolicy.ValidateContentLength(new StringValues(value));
        Assert.False(result.IsValid);
        Assert.Equal("invalid-content-length", result.Code);
    }

    [Fact]
    public void ContentLength_RejectsMultipleFieldValues()
    {
        var result = RequestFramingPolicy.ValidateContentLength(new StringValues(new[] { "10", "10" }));
        Assert.False(result.IsValid);
        Assert.Equal("multiple-content-length", result.Code);
    }

    [Theory]
    [InlineData("chunked")]
    [InlineData("CHUNKED")]
    [InlineData(" chunked ")]
    public void TransferEncoding_AcceptsOnlySingleChunkedCoding(string value)
        => Assert.True(RequestFramingPolicy.ValidateTransferEncoding(new StringValues(value)).IsValid);

    [Theory]
    [InlineData("")]
    [InlineData("gzip")]
    [InlineData("compress")]
    [InlineData("chunked, gzip")]
    [InlineData("gzip, chunked")]
    public void TransferEncoding_RejectsUnsupportedOrChainedCodings(string value)
    {
        var result = RequestFramingPolicy.ValidateTransferEncoding(new StringValues(value));
        Assert.False(result.IsValid);
        Assert.Equal("unsupported-transfer-encoding", result.Code);
    }

    [Fact]
    public void TransferEncoding_RejectsMultipleFieldValues()
    {
        var result = RequestFramingPolicy.ValidateTransferEncoding(new StringValues(new[] { "chunked", "chunked" }));
        Assert.False(result.IsValid);
        Assert.Equal("multiple-transfer-encoding", result.Code);
    }

    [Fact]
    public void MissingFramingMetadata_IsValid()
    {
        Assert.True(RequestFramingPolicy.ValidateContentLength(StringValues.Empty).IsValid);
        Assert.True(RequestFramingPolicy.ValidateTransferEncoding(StringValues.Empty).IsValid);
    }
}
