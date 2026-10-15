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

    [Theory]
    [InlineData(0xC3, 0x28)] // Invalid two-byte continuation.
    [InlineData(0xC0, 0xAF)] // Overlong encoding.
    [InlineData(0xED, 0xA0)] // UTF-8 surrogate prefix.
    [InlineData(0xF4, 0x90)] // Code point above U+10FFFF.
    public void Decrypt_RejectsAuthenticatedInvalidUtf8(int first, int second)
    {
        // Build an authentic envelope containing invalid UTF-8 bytes. Tampering with an
        // existing envelope would only test the GCM tag, not the text decoder.
        var salt = System.Security.Cryptography.RandomNumberGenerator.GetBytes(16);
        var nonce = System.Security.Cryptography.RandomNumberGenerator.GetBytes(12);
        var associatedData = Encoding.UTF8.GetBytes(Purpose);
        var key = System.Security.Cryptography.Rfc2898DeriveBytes.Pbkdf2(
            Secret, salt, AuthenticatedEncryptionUtils.CurrentIterations,
            System.Security.Cryptography.HashAlgorithmName.SHA256, 32);
        var ciphertext = new byte[2];
        var tag = new byte[16];
        var invalidBytes = new[] { (byte)first, (byte)second };

        try
        {
            using (var aes = new System.Security.Cryptography.AesGcm(key, 16))
            {
                aes.Encrypt(nonce, invalidBytes, ciphertext, tag, associatedData);
            }

            var envelope = string.Join(
                "$",
                AuthenticatedEncryptionUtils.EnvelopePrefix,
                AuthenticatedEncryptionUtils.CurrentIterations.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Convert.ToBase64String(salt),
                Convert.ToBase64String(nonce),
                Convert.ToBase64String(tag),
                Convert.ToBase64String(ciphertext));

            Assert.True(AuthenticatedEncryptionUtils.IsModernEnvelope(envelope));
            Assert.Throws<DecoderFallbackException>(() =>
                AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
            Assert.False(AuthenticatedEncryptionUtils.TryDecrypt(
                envelope, Secret, Purpose, out var plaintext));
            Assert.Null(plaintext);
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(key);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(associatedData);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(invalidBytes);
        }
    }

}
