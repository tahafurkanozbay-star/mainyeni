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

    // Construct invalid UTF-16 inside the test: xUnit theory argument serialization
    // can replace unpaired surrogate literals before the test receives them.
    [Theory]
    [InlineData(0xD800)]
    [InlineData(0xDC00)]
    public void Encrypt_RejectsUnpairedSurrogates(int surrogateCodeUnit)
    {
        var malformed = new string((char)surrogateCodeUnit, 1);
        Assert.Throws<EncoderFallbackException>(() =>
            AuthenticatedEncryptionUtils.Encrypt(malformed, Secret, Purpose));
        Assert.Throws<EncoderFallbackException>(() =>
            AuthenticatedEncryptionUtils.Encrypt("before" + malformed + "after", Secret, Purpose));
    }

    [Theory]
    [InlineData(0xD800)]
    [InlineData(0xDC00)]
    public void Purpose_RejectsUnpairedSurrogates(int surrogateCodeUnit)
    {
        var purpose = "prefix" + new string((char)surrogateCodeUnit, 1);
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
