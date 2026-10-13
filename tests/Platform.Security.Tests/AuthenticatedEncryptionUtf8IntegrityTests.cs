using System;
using System.Text;
using Toolbox.Security.Cryptography;
using Xunit;

namespace Platform.Security.Tests;

/// <summary>Strict Unicode admission and backward-compatible valid text.</summary>
public sealed class AuthenticatedEncryptionUtf8IntegrityTests
{
    private const string Secret = "test-secret-with-sufficient-entropy";
    private const string Purpose = "platform-security-test";

    [Theory]
    [InlineData("\uD800")]
    [InlineData("\uDC00")]
    [InlineData("before\uD800after")]
    public void Encrypt_RejectsUnpairedSurrogates(string value)
    {
        Assert.Throws<EncoderFallbackException>(() =>
            AuthenticatedEncryptionUtils.Encrypt(value, Secret, Purpose));
    }

    [Theory]
    [InlineData("\uD800")]
    [InlineData("prefix\uDC00")]
    public void Purpose_RejectsUnpairedSurrogates(string purpose)
    {
        Assert.Throws<EncoderFallbackException>(() =>
            AuthenticatedEncryptionUtils.Encrypt("valid", Secret, purpose));
        Assert.Throws<EncoderFallbackException>(() =>
            AuthenticatedEncryptionUtils.Decrypt("not-an-envelope", Secret, purpose));
    }

    [Fact]
    public void ValidMultibyteUnicode_StillRoundTrips()
    {
        const string value = "İstanbul / Ankara / 🗺️ / ğüşöç";
        var envelope = AuthenticatedEncryptionUtils.Encrypt(value, Secret, Purpose);
        Assert.Equal(value, AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
    }
}
