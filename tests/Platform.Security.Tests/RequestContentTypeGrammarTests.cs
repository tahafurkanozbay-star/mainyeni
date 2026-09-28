using Api.Core.Platform;
using Api.Core.Platform.Governance;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;
using System;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RequestContentTypeGrammarTests
{
    private readonly ApiPlatformOptionsValidator validator = new();

    [Theory]
    [InlineData("application/json")]
    [InlineData("Application/JSON")]
    [InlineData("application/vnd.kentrehberi.item+json")]
    [InlineData("application/problem+json")]
    [InlineData("application/x-www-form-urlencoded")]
    [InlineData("multipart/form-data")]
    [InlineData("text/plain")]
    [InlineData("application/vnd.example-v2+json; charset=utf-8")]
    public void IsValidRequestMediaType_AcceptsConcreteTokenGrammar(string contentType)
    {
        Assert.True(RequestContentPolicy.IsValidRequestMediaType(contentType));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("application/")]
    [InlineData("/json")]
    [InlineData("application//json")]
    [InlineData("application/json/extra")]
    [InlineData("application/ json")]
    [InlineData("application /json")]
    [InlineData("application/json value")]
    [InlineData("application/json@")]
    [InlineData("application/*")]
    [InlineData("application/*+json")]
    [InlineData("*/json")]
    [InlineData("application/😀")]
    public void IsValidRequestMediaType_RejectsMalformedOrWildcardValues(string contentType)
    {
        Assert.False(RequestContentPolicy.IsValidRequestMediaType(contentType));
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("APPLICATION/JSON")]
    [InlineData("application/geo+json")]
    [InlineData("application/problem+json")]
    [InlineData("application/x-www-form-urlencoded")]
    [InlineData("multipart/form-data")]
    [InlineData("image/*")]
    [InlineData("text/*")]
    [InlineData("application/*+json")]
    public void IsValidAllowedMediaTypePattern_AcceptsSupportedPatterns(string pattern)
    {
        Assert.True(RequestContentPolicy.IsValidAllowedMediaTypePattern(pattern));
    }

    [Theory]
    [InlineData("")]
    [InlineData("application/")]
    [InlineData("/json")]
    [InlineData("*/*")]
    [InlineData("*/json")]
    [InlineData("application/**")]
    [InlineData("application/*+xml")]
    [InlineData("application/vnd.*+json")]
    [InlineData("application/json*")]
    [InlineData("application//json")]
    [InlineData("application/json/extra")]
    [InlineData("application/ json")]
    [InlineData("application/json value")]
    [InlineData("application/😀")]
    public void IsValidAllowedMediaTypePattern_RejectsUnsupportedOrMalformedPatterns(string pattern)
    {
        Assert.False(RequestContentPolicy.IsValidAllowedMediaTypePattern(pattern));
    }

    [Fact]
    public void IsAllowed_RejectsMalformedRequestEvenWhenAllowlistContainsSameMalformedValue()
    {
        const string malformed = "application/json value";

        Assert.False(RequestContentPolicy.IsAllowed(malformed, new[] { malformed }));
    }

    [Fact]
    public void IsAllowed_RejectsRequestWildcardEvenWhenConfiguredWildcardMatchesTextually()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "application/*+json",
            new[] { "application/*+json" }));
    }

    [Fact]
    public void IsAllowed_InvalidConfiguredPatternIsIgnoredFailClosed()
    {
        Assert.False(RequestContentPolicy.IsAllowed(
            "application/vnd.kentrehberi.item+xml",
            new[] { "application/*+xml" }));
    }

    [Theory]
    [InlineData("application/vnd.kentrehberi.item+json")]
    [InlineData("application/problem+json")]
    [InlineData("application/geo+json")]
    public void IsAllowed_StructuredJsonWildcardStillMatchesConcreteApplicationSubtypes(string contentType)
    {
        Assert.True(RequestContentPolicy.IsAllowed(
            contentType,
            new[] { "application/*+json" }));
    }

    [Fact]
    public void IsAllowed_TypeWildcardStillMatchesOnlyConcreteSubtype()
    {
        Assert.True(RequestContentPolicy.IsAllowed("image/png", new[] { "image/*" }));
        Assert.False(RequestContentPolicy.IsAllowed("image/*", new[] { "image/*" }));
        Assert.False(RequestContentPolicy.IsAllowed("image/png/extra", new[] { "image/*" }));
    }

    [Theory]
    [InlineData("*/*")]
    [InlineData("*/json")]
    [InlineData("application/*+xml")]
    [InlineData("application/vnd.*+json")]
    [InlineData("application//json")]
    [InlineData("application/json/extra")]
    [InlineData("application/ json")]
    [InlineData("application/json value")]
    [InlineData("application/😀")]
    public void Validator_RejectsInvalidAllowedBodyMediaTypePatterns(string pattern)
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes.Clear();
        options.Governance.AllowedBodyContentTypes.Add(pattern);

        var result = validator.Validate(Options.DefaultName, options);

        Assert.False(result.Succeeded);
        Assert.Contains(
            result.Failures ?? Array.Empty<string>(),
            failure => failure.Contains("media type", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("application/geo+json")]
    [InlineData("application/*+json")]
    [InlineData("image/*")]
    public void Validator_AcceptsSupportedAllowedBodyMediaTypePatterns(string pattern)
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes.Clear();
        options.Governance.AllowedBodyContentTypes.Add(pattern);

        var result = validator.Validate(Options.DefaultName, options);

        Assert.True(result.Succeeded);
    }

    [Theory]
    [InlineData("application//json")]
    [InlineData("application/json/extra")]
    [InlineData("application/ json")]
    [InlineData("application/json value")]
    [InlineData("application/*+json")]
    [InlineData("application/😀")]
    public void Evaluator_RejectsMalformedBodyContentTypeBeforeModelBinding(string contentType)
    {
        var options = new ApiPlatformOptions();
        options.Governance.AllowedBodyContentTypes.Add(contentType);
        var evaluator = new RequestGovernanceEvaluator(options);
        var context = CreateBodyContext(contentType);

        var decision = evaluator.Evaluate(context);

        Assert.False(decision.Allowed);
        Assert.Equal(StatusCodes.Status415UnsupportedMediaType, decision.StatusCode);
        Assert.Equal("unsupported-content-type", decision.Code);
    }

    [Theory]
    [InlineData("application/json; charset=utf-8")]
    [InlineData("application/vnd.kentrehberi.item+json; charset=utf-8")]
    [InlineData("multipart/form-data; boundary=abc123")]
    public void Evaluator_PreservesValidParameterizedContentTypes(string contentType)
    {
        var evaluator = new RequestGovernanceEvaluator(new ApiPlatformOptions());
        var context = CreateBodyContext(contentType);

        Assert.True(evaluator.Evaluate(context).Allowed);
    }

    private static DefaultHttpContext CreateBodyContext(string contentType)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Post;
        context.Request.ContentLength = 16;
        context.Request.ContentType = contentType;
        context.Request.Path = "/api/items";

        var feature = context.Features.Get<IHttpRequestFeature>();
        if (feature != null)
        {
            feature.RawTarget = "/api/items";
        }

        return context;
    }
}
