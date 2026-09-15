using Microsoft.IdentityModel.Tokens;
using System;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;
using System.Security.Cryptography;
using Toolbox.Security.Jwt;
using Xunit;

namespace Platform.Security.Tests;

public sealed class JwtUtilsTests
{
    [Fact]
    public void GenerateToken_Throws_WhenSubjectIsMissing()
    {
        using var environment = new TestEnvironment();

        Assert.Throws<ArgumentException>(() => JwtUtils.GenerateToken(string.Empty));
        Assert.Throws<ArgumentException>(() => JwtUtils.GenerateToken("   "));
    }

    [Fact]
    public void GenerateToken_Throws_WhenSigningKeyIsMissing()
    {
        using var environment = new TestEnvironment();
        environment.ClearJwtSigningKey();

        var exception = Assert.Throws<InvalidOperationException>(() => JwtUtils.GenerateToken("subject"));

        Assert.Contains("KENT_REHBERI_JWT_SIGNING_KEY", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GenerateToken_Throws_WhenSigningKeyIsNotBase64()
    {
        using var environment = new TestEnvironment();
        environment.SetJwtSigningKeyRaw("not-base64!!!");

        var exception = Assert.Throws<InvalidOperationException>(() => JwtUtils.GenerateToken("subject"));

        Assert.Contains("base64", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GenerateToken_Throws_WhenSigningKeyIsTooShort()
    {
        using var environment = new TestEnvironment();
        environment.SetJwtSigningKeyRaw(Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)));

        var exception = Assert.Throws<InvalidOperationException>(() => JwtUtils.GenerateToken("subject"));

        Assert.Contains("32", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GenerateToken_ProducesSignedToken_WithExpectedClaims()
    {
        using var environment = new TestEnvironment();
        const string subject = "encrypted-user-guid";

        var token = JwtUtils.GenerateToken(subject);
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        Assert.Equal(environment.Issuer, jwt.Issuer);
        Assert.Contains(environment.Audience, jwt.Audiences);
        Assert.Equal(SecurityAlgorithms.HmacSha256, jwt.Header.Alg);
        Assert.Equal(subject, jwt.Claims.Single(x => x.Type == JwtRegisteredClaimNames.UniqueName).Value);
        Assert.False(string.IsNullOrWhiteSpace(jwt.Id));
        Assert.True(jwt.ValidFrom <= DateTime.UtcNow.AddSeconds(5));
        Assert.True(jwt.ValidTo > DateTime.UtcNow.AddMinutes(25));
        Assert.True(jwt.ValidTo <= DateTime.UtcNow.AddMinutes(31));
    }

    [Fact]
    public void GenerateToken_AssignsUniqueJti_ForEveryToken()
    {
        using var environment = new TestEnvironment();

        var first = new JwtSecurityTokenHandler().ReadJwtToken(JwtUtils.GenerateToken("same-subject"));
        var second = new JwtSecurityTokenHandler().ReadJwtToken(JwtUtils.GenerateToken("same-subject"));

        Assert.NotEqual(first.Id, second.Id);
    }

    [Fact]
    public void GenerateToken_FallsBackToDefaultIssuerAndAudience_WhenOverridesAreWhitespace()
    {
        using var environment = new TestEnvironment();
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_ISSUER", "   ");
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_AUDIENCE", "\t");

        var token = JwtUtils.GenerateToken("encrypted-guid");
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        Assert.Equal("kent-rehberi-api", jwt.Issuer);
        Assert.Contains("kent-rehberi-admin", jwt.Audiences);
        Assert.NotNull(JwtUtils.GetPrincipal(token));
    }

    [Fact]
    public void GetPrincipal_ValidatesToken_AndMapsNameClaim()
    {
        using var environment = new TestEnvironment();
        var token = JwtUtils.GenerateToken("encrypted-guid");

        var principal = JwtUtils.GetPrincipal(token);

        Assert.NotNull(principal);
        Assert.Equal("encrypted-guid", principal!.FindFirst(ClaimTypes.Name)?.Value);
        Assert.True(JwtUtils.ValidateToken(token));
    }

    [Fact]
    public void GetPrincipal_RejectsTamperedSignature()
    {
        using var environment = new TestEnvironment();
        var token = JwtUtils.GenerateToken("encrypted-guid");
        var parts = token.Split('.');
        Assert.Equal(3, parts.Length);

        var signature = parts[2];
        var replacement = signature[0] == 'A' ? 'B' : 'A';
        parts[2] = replacement + signature.Substring(1);
        var tampered = string.Join('.', parts);

        Assert.Null(JwtUtils.GetPrincipal(tampered));
        Assert.False(JwtUtils.ValidateToken(tampered));
    }

    [Fact]
    public void GetPrincipal_RejectsToken_WhenIssuerChanges()
    {
        using var environment = new TestEnvironment();
        environment.SetJwtConfiguration(issuer: "issuer-a", audience: "audience-a");
        var token = JwtUtils.GenerateToken("encrypted-guid");

        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_ISSUER", "issuer-b");

        Assert.Null(JwtUtils.GetPrincipal(token));
    }

    [Fact]
    public void GetPrincipal_RejectsToken_WhenAudienceChanges()
    {
        using var environment = new TestEnvironment();
        environment.SetJwtConfiguration(issuer: "issuer-a", audience: "audience-a");
        var token = JwtUtils.GenerateToken("encrypted-guid");

        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_AUDIENCE", "audience-b");

        Assert.Null(JwtUtils.GetPrincipal(token));
    }

    [Fact]
    public void GetPrincipal_RejectsToken_WhenSigningKeyRotates()
    {
        using var environment = new TestEnvironment();
        environment.SetJwtConfiguration(signingKey: RandomNumberGenerator.GetBytes(64));
        var token = JwtUtils.GenerateToken("encrypted-guid");

        environment.SetJwtConfiguration(signingKey: RandomNumberGenerator.GetBytes(64));

        Assert.Null(JwtUtils.GetPrincipal(token));
    }

    [Fact]
    public void GetPrincipal_ReturnsNull_WhenSigningKeyConfigurationBecomesInvalid()
    {
        using var environment = new TestEnvironment();
        var token = JwtUtils.GenerateToken("encrypted-guid");
        environment.SetJwtSigningKeyRaw("not-valid-base64");

        Assert.Null(JwtUtils.GetPrincipal(token));
        Assert.False(JwtUtils.ValidateToken(token));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-jwt")]
    [InlineData("a.b")]
    [InlineData("a.b.c")]
    public void GetPrincipal_ReturnsNull_ForMalformedTokens(string? token)
    {
        using var environment = new TestEnvironment();

        Assert.Null(JwtUtils.GetPrincipal(token!));
        Assert.False(JwtUtils.ValidateToken(token!));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Bearer")]
    [InlineData("Bearer ")]
    [InlineData("Basic abc")]
    [InlineData("Token abc")]
    [InlineData("Bearer one two")]
    [InlineData("Bearer one\ttwo")]
    [InlineData("Bearer one\ntwo")]
    [InlineData("Bearer one\rtwo")]
    public void TryGetBearerToken_RejectsInvalidAuthorizationHeaders(string? header)
    {
        Assert.False(JwtUtils.TryGetBearerToken(header!, out var token));
        Assert.Null(token);
    }

    [Theory]
    [InlineData("Bearer abc", "abc")]
    [InlineData("bearer abc", "abc")]
    [InlineData("BEARER abc", "abc")]
    [InlineData("Bearer    abc   ", "abc")]
    public void TryGetBearerToken_AcceptsCaseInsensitiveBearerScheme(string header, string expected)
    {
        Assert.True(JwtUtils.TryGetBearerToken(header, out var token));
        Assert.Equal(expected, token);
    }

    [Fact]
    public void ReadToken_ReturnsDecodedJwt_WithoutTreatingDecodeAsAuthorization()
    {
        using var environment = new TestEnvironment();
        var encoded = JwtUtils.GenerateToken("encrypted-guid");

        var decoded = JwtUtils.ReadToken(encoded);

        Assert.NotNull(decoded);
        Assert.Equal(environment.Issuer, decoded!.Issuer);
        Assert.Equal("encrypted-guid", decoded.Claims.Single(x => x.Type == JwtRegisteredClaimNames.UniqueName).Value);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("invalid")]
    [InlineData("a.b")]
    [InlineData("a.b.c")]
    public void ReadToken_ReturnsNull_ForUnreadableInput(string? token)
    {
        Assert.Null(JwtUtils.ReadToken(token!));
    }
}
