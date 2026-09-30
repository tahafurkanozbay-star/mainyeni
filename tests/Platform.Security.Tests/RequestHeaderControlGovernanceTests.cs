using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestHeaderControlGovernanceTests
{
    [Theory]
    [InlineData("\0")]
    [InlineData("\u0001")]
    [InlineData("\u0008")]
    [InlineData("\u000b")]
    [InlineData("\u000c")]
    [InlineData("\u000e")]
    [InlineData("\u001f")]
    [InlineData("\u007f")]
    public void Inspector_rejects_forbidden_http_field_value_controls(string value)
    {
        var headers = NewHeaders(("X-Test", "prefix" + value + "suffix"));
        Assert.True(RequestHeaderInspector.ContainsInvalidControlCharacter(headers));
    }

    [Theory]
    [InlineData(0x00)]
    [InlineData(0x01)]
    [InlineData(0x02)]
    [InlineData(0x03)]
    [InlineData(0x04)]
    [InlineData(0x05)]
    [InlineData(0x06)]
    [InlineData(0x07)]
    [InlineData(0x08)]
    [InlineData(0x0b)]
    [InlineData(0x0c)]
    [InlineData(0x0e)]
    [InlineData(0x0f)]
    [InlineData(0x10)]
    [InlineData(0x11)]
    [InlineData(0x12)]
    [InlineData(0x13)]
    [InlineData(0x14)]
    [InlineData(0x15)]
    [InlineData(0x16)]
    [InlineData(0x17)]
    [InlineData(0x18)]
    [InlineData(0x19)]
    [InlineData(0x1a)]
    [InlineData(0x1b)]
    [InlineData(0x1c)]
    [InlineData(0x1d)]
    [InlineData(0x1e)]
    [InlineData(0x1f)]
    [InlineData(0x7f)]
    public void Inspector_rejects_every_non_whitespace_c0_control_and_del(int codePoint)
    {
        var headers = NewHeaders(("X-Test", "a" + (char)codePoint + "b"));
        Assert.True(RequestHeaderInspector.ContainsInvalidControlCharacter(headers));
    }

    [Theory]
    [InlineData(0x20)]
    [InlineData(0x21)]
    [InlineData(0x7e)]
    [InlineData(0x80)]
    [InlineData(0xe9)]
    public void Inspector_accepts_visible_and_obs_text_characters(int codePoint)
    {
        var headers = NewHeaders(("X-Test", "a" + (char)codePoint + "b"));
        Assert.False(RequestHeaderInspector.ContainsInvalidControlCharacter(headers));
    }

    [Fact]
    public void Inspector_accepts_horizontal_tab_as_http_optional_whitespace()
    {
        var headers = NewHeaders(("X-Test", "alpha\tbeta"));
        Assert.False(RequestHeaderInspector.ContainsInvalidControlCharacter(headers));
    }

    [Theory]
    [InlineData("\r")]
    [InlineData("\n")]
    [InlineData("\r\n")]
    public void Newline_detection_remains_separate_for_specific_policy_reason(string newline)
    {
        var headers = NewHeaders(("X-Test", "alpha" + newline + "beta"));
        Assert.True(RequestHeaderInspector.ContainsNewline(headers));
        Assert.False(RequestHeaderInspector.ContainsInvalidControlCharacter(headers));
    }

    [Fact]
    public void Empty_and_null_header_collections_do_not_report_invalid_controls()
    {
        Assert.False(RequestHeaderInspector.ContainsInvalidControlCharacter(null!));
        Assert.False(RequestHeaderInspector.ContainsInvalidControlCharacter(new HeaderDictionary()));
    }

    [Fact]
    public void Multiple_values_are_scanned_without_retaining_sensitive_values()
    {
        var headers = new HeaderDictionary
        {
            ["Authorization"] = new StringValues(new[] { "Bearer safe", "Bearer bad\0value" })
        };

        Assert.True(RequestHeaderInspector.ContainsInvalidControlCharacter(headers));
        var snapshot = RequestHeaderInspector.Inspect(headers);
        Assert.Equal(2, snapshot.AuthorizationValueCount);
        Assert.True(snapshot.AuthorizationBytes > 0);
    }

    [Fact]
    public void Evaluator_rejects_nul_in_ordinary_header_fail_closed()
    {
        var context = NewContext();
        context.Request.Headers["X-Client-Metadata"] = "alpha\0omega";

        var decision = NewEvaluator().Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status431RequestHeaderFieldsTooLarge, decision.StatusCode);
        Assert.Equal("header-control-character", decision.Code);
    }

    [Fact]
    public void Evaluator_rejects_del_in_cookie_header_fail_closed()
    {
        var context = NewContext();
        context.Request.Headers["Cookie"] = "session=abc\u007fdef";

        var decision = NewEvaluator().Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status431RequestHeaderFieldsTooLarge, decision.StatusCode);
        Assert.Equal("header-control-character", decision.Code);
    }

    [Fact]
    public void Evaluator_rejects_control_in_authorization_without_echoing_value()
    {
        var context = NewContext();
        context.Request.Headers["Authorization"] = "Bearer secret\u001fmaterial";

        var decision = NewEvaluator().Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal("header-control-character", decision.Code);
        Assert.DoesNotContain("secret", decision.Detail, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("material", decision.Detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Evaluator_allows_horizontal_tab_when_other_header_limits_are_valid()
    {
        var context = NewContext();
        context.Request.Headers["X-Metadata"] = "alpha\tbeta";

        var decision = NewEvaluator().Evaluate(context);

        Assert.True(decision.Allowed);
    }

    [Fact]
    public void Evaluator_preserves_specific_newline_rejection_reason()
    {
        var context = NewContext();
        context.Request.Headers["X-Metadata"] = "alpha\r\nbeta";

        var decision = NewEvaluator().Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal("header-newline", decision.Code);
        Assert.Equal(StatusCodes.Status431RequestHeaderFieldsTooLarge, decision.StatusCode);
    }

    [Fact]
    public void Evaluator_can_disable_legacy_newline_policy_without_disabling_other_control_rejection()
    {
        var options = NewOptions();
        options.Governance.RejectHeaderNewlines = false;
        var evaluator = new RequestGovernanceEvaluator(options);

        var newlineContext = NewContext();
        newlineContext.Request.Headers["X-Metadata"] = "alpha\r\nbeta";
        Assert.True(evaluator.Evaluate(newlineContext).Allowed);

        var nulContext = NewContext();
        nulContext.Request.Headers["X-Metadata"] = "alpha\0beta";
        var nulDecision = evaluator.Evaluate(nulContext);
        Assert.False(nulDecision.Allowed);
        Assert.Equal("header-control-character", nulDecision.Code);
    }

    [Fact]
    public void Header_snapshot_counts_utf8_bytes_and_values_deterministically()
    {
        var headers = new HeaderDictionary
        {
            ["X-A"] = new StringValues(new[] { "one", "two" }),
            ["X-B"] = "İstanbul"
        };

        var first = RequestHeaderInspector.Inspect(headers);
        var second = RequestHeaderInspector.Inspect(headers);

        Assert.Equal(2, first.HeaderCount);
        Assert.Equal(3, first.HeaderValueCount);
        Assert.Equal(first.EstimatedUtf8Bytes, second.EstimatedUtf8Bytes);
        Assert.True(first.EstimatedUtf8Bytes > 0);
    }

    [Fact]
    public void Header_snapshot_does_not_treat_absent_sensitive_headers_as_present()
    {
        var snapshot = RequestHeaderInspector.Inspect(NewHeaders(("X-Test", "value")));

        Assert.Equal(0, snapshot.AuthorizationBytes);
        Assert.Equal(0, snapshot.CookieBytes);
        Assert.Equal(0, snapshot.ForwardedForBytes);
        Assert.Equal(0, snapshot.AuthorizationValueCount);
    }

    private static RequestGovernanceEvaluator NewEvaluator() => new(NewOptions());

    private static ApiPlatformOptions NewOptions()
    {
        return new ApiPlatformOptions
        {
            Governance = new ApiPlatformOptions.GovernanceOptions
            {
                Enabled = true,
                RejectHeaderNewlines = true,
                MaxRawTargetChars = 8192,
                MaxPathChars = 4096,
                MaxQueryStringChars = 4096,
                MaxQueryParameters = 128,
                MaxHeaderCount = 128,
                MaxHeaderValues = 256,
                MaxHeaderBytes = 65536,
                MaxAuthorizationHeaderBytes = 16384,
                MaxCookieHeaderBytes = 32768,
                MaxContentTypeHeaderBytes = 1024,
                MaxForwardedForHeaderBytes = 4096,
                RequireKnownContentTypeForBodyRequests = true
            }
        };
    }

    private static DefaultHttpContext NewContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/test";
        return context;
    }

    private static HeaderDictionary NewHeaders(params (string Name, string Value)[] values)
    {
        var headers = new HeaderDictionary();
        foreach (var value in values)
        {
            headers[value.Name] = value.Value;
        }
        return headers;
    }
}
