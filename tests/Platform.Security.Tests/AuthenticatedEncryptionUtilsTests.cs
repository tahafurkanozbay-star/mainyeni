using System;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using Toolbox.Security;
using Toolbox.Security.Cryptography;
using Xunit;

namespace Platform.Security.Tests;

public sealed class AuthenticatedEncryptionUtilsTests
{
    private const string Secret = "test-secret-with-sufficient-entropy";
    private const string Purpose = "platform-security-test";

    [Fact]
    public void EncryptAndDecrypt_RoundTripsUnicode()
    {
        const string plaintext = "Ankara / Çankaya / ğüşiöç / 🗺️";
        var envelope = AuthenticatedEncryptionUtils.Encrypt(plaintext, Secret, Purpose);

        Assert.Equal(
            plaintext,
            AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
        Assert.True(AuthenticatedEncryptionUtils.IsModernEnvelope(envelope));
        Assert.False(AuthenticatedEncryptionUtils.NeedsReencryption(envelope));
    }

    [Fact]
    public void Encrypt_UsesFreshSaltAndNonce()
    {
        var first = AuthenticatedEncryptionUtils.Encrypt("same", Secret, Purpose);
        var second = AuthenticatedEncryptionUtils.Encrypt("same", Secret, Purpose);

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void Decrypt_FailsWhenPurposeChanges()
    {
        var envelope = AuthenticatedEncryptionUtils.Encrypt("protected", Secret, Purpose);

        Assert.Throws<CryptographicException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                envelope,
                Secret,
                "different-purpose"));
    }

    [Fact]
    public void Decrypt_FailsWhenSecretChanges()
    {
        var envelope = AuthenticatedEncryptionUtils.Encrypt("protected", Secret, Purpose);

        Assert.Throws<CryptographicException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                envelope,
                "wrong-secret",
                Purpose));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public void Decrypt_FailsWhenEnvelopeSegmentIsTampered(int partIndex)
    {
        var envelope = AuthenticatedEncryptionUtils.Encrypt("protected", Secret, Purpose);
        var parts = envelope.Split('$');
        var bytes = Convert.FromBase64String(parts[partIndex]);

        if (bytes.Length == 0)
        {
            bytes = [1];
        }
        else
        {
            bytes[0] ^= 0x01;
        }

        parts[partIndex] = Convert.ToBase64String(bytes);

        Assert.Throws<CryptographicException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                string.Join('$', parts),
                Secret,
                Purpose));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("legacy")]
    [InlineData("aes-gcm-v1")]
    [InlineData("aes-gcm-v1$600000$a$b$c")]
    public void EnvelopeInspection_RejectsMalformedPayloads(string? envelope)
    {
        Assert.False(AuthenticatedEncryptionUtils.IsModernEnvelope(envelope!));
        Assert.True(AuthenticatedEncryptionUtils.NeedsReencryption(envelope!));
    }

    [Theory]
    [InlineData(99_999)]
    [InlineData(2_000_001)]
    public void Decrypt_RejectsUnboundedIterationCounts(int iterations)
    {
        var parts = AuthenticatedEncryptionUtils
            .Encrypt("protected", Secret, Purpose)
            .Split('$');
        parts[1] = iterations.ToString(CultureInfo.InvariantCulture);

        Assert.Throws<FormatException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                string.Join('$', parts),
                Secret,
                Purpose));
    }

    [Fact]
    public void Decrypt_RejectsNonNumericIterationCount()
    {
        var parts = AuthenticatedEncryptionUtils
            .Encrypt("protected", Secret, Purpose)
            .Split('$');
        parts[1] = "many";

        Assert.Throws<FormatException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                string.Join('$', parts),
                Secret,
                Purpose));
    }

    [Theory]
    [InlineData(2, 15)]
    [InlineData(3, 11)]
    [InlineData(4, 15)]
    public void Decrypt_RejectsInvalidFixedLengthSegments(int partIndex, int byteLength)
    {
        var parts = AuthenticatedEncryptionUtils
            .Encrypt("protected", Secret, Purpose)
            .Split('$');
        parts[partIndex] = Convert.ToBase64String(new byte[byteLength]);

        Assert.Throws<FormatException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                string.Join('$', parts),
                Secret,
                Purpose));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public void Decrypt_RejectsInvalidBase64Segments(int partIndex)
    {
        var parts = AuthenticatedEncryptionUtils
            .Encrypt("protected", Secret, Purpose)
            .Split('$');
        parts[partIndex] = "***";

        Assert.Throws<FormatException>(
            () => AuthenticatedEncryptionUtils.Decrypt(
                string.Join('$', parts),
                Secret,
                Purpose));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Encrypt_RejectsMissingSecret(string? secret)
    {
        Assert.Throws<ArgumentException>(
            () => AuthenticatedEncryptionUtils.Encrypt(
                "protected",
                secret!,
                Purpose));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Encrypt_RejectsMissingPurpose(string? purpose)
    {
        Assert.Throws<ArgumentException>(
            () => AuthenticatedEncryptionUtils.Encrypt(
                "protected",
                Secret,
                purpose!));
    }

    [Fact]
    public void Encrypt_RejectsNullPlaintext()
    {
        Assert.Throws<ArgumentNullException>(
            () => AuthenticatedEncryptionUtils.Encrypt(
                null!,
                Secret,
                Purpose));
    }

    [Fact]
    public void Encrypt_AllowsEmptyPlaintext()
    {
        var envelope = AuthenticatedEncryptionUtils.Encrypt(
            string.Empty,
            Secret,
            Purpose);

        Assert.Equal(
            string.Empty,
            AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
    }

    [Fact]
    public void TryDecrypt_ReturnsFalseForAuthenticationFailure()
    {
        var envelope = AuthenticatedEncryptionUtils.Encrypt("protected", Secret, Purpose);

        var success = AuthenticatedEncryptionUtils.TryDecrypt(
            envelope,
            "wrong-secret",
            Purpose,
            out var plaintext);

        Assert.False(success);
        Assert.Null(plaintext);
    }

    [Fact]
    public void TryDecrypt_ReturnsFalseForMalformedEnvelope()
    {
        var success = AuthenticatedEncryptionUtils.TryDecrypt(
            "not-an-envelope",
            Secret,
            Purpose,
            out var plaintext);

        Assert.False(success);
        Assert.Null(plaintext);
    }

    [Fact]
    public void TryDecrypt_ReturnsPlaintextForValidEnvelope()
    {
        var envelope = AuthenticatedEncryptionUtils.Encrypt("protected", Secret, Purpose);

        var success = AuthenticatedEncryptionUtils.TryDecrypt(
            envelope,
            Secret,
            Purpose,
            out var plaintext);

        Assert.True(success);
        Assert.Equal("protected", plaintext);
    }

    [Fact]
    public void Envelope_UsesExpectedVersionAndWorkFactor()
    {
        var parts = AuthenticatedEncryptionUtils
            .Encrypt("protected", Secret, Purpose)
            .Split('$');

        Assert.Equal(6, parts.Length);
        Assert.Equal(AuthenticatedEncryptionUtils.EnvelopePrefix, parts[0]);
        Assert.Equal(
            AuthenticatedEncryptionUtils.CurrentIterations
                .ToString(CultureInfo.InvariantCulture),
            parts[1]);
        Assert.Equal(16, Convert.FromBase64String(parts[2]).Length);
        Assert.Equal(12, Convert.FromBase64String(parts[3]).Length);
        Assert.Equal(16, Convert.FromBase64String(parts[4]).Length);
    }

    [Fact]
    public void CryptoUtils_CreateRandomSalt_ProducesRequestedNumericShape()
    {
        foreach (var digits in new[] { 1, 2, 3, 8, 32 })
        {
            var salt = CryptoUtils.CreateRandomSalt(digits);

            Assert.Equal(digits, salt.Length);
            Assert.InRange(salt[0], '1', '9');
            Assert.All(salt, character => Assert.InRange(character, '0', '9'));
        }
    }

    [Fact]
    public void CryptoUtils_CreateRandomSalt_NormalizesNonPositiveLengthToOneDigit()
    {
        Assert.Single(CryptoUtils.CreateRandomSalt(0));
        Assert.Single(CryptoUtils.CreateRandomSalt(-10));
    }

    [Fact]
    public void CryptoUtils_CreateRandomString_UsesOnlyDocumentedAlphabet()
    {
        const string alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        var value = CryptoUtils.CreateRandomString(512);

        Assert.Equal(512, value.Length);
        Assert.All(value, character => Assert.Contains(character, alphabet));
    }

    [Fact]
    public void CryptoUtils_CreateRandomString_AllowsEmptyOutput()
    {
        Assert.Equal(string.Empty, CryptoUtils.CreateRandomString(0));
    }

    [Fact]
    public void CryptoUtils_CreateRandomString_RejectsNegativeLength()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => CryptoUtils.CreateRandomString(-1));
    }

    [Theory]
    [InlineData(4097)]
    [InlineData(10_000)]
    public void CryptoUtils_RandomGenerators_RejectUnboundedAllocationRequests(int length)
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => CryptoUtils.CreateRandomString(length));
        Assert.Throws<ArgumentOutOfRangeException>(
            () => CryptoUtils.CreateRandomSalt(length));
    }

    [Fact]
    public void CryptoUtils_DecryptRequiresExplicitLegacySalt()
    {
        Assert.Throws<ArgumentException>(
            () => CryptoUtils.EncryptDecrypt(
                new Base64Encryptor(),
                CryptoMethod.DECRYPT,
                "QQ==",
                string.Empty));
    }

    [Fact]
    public void CryptoUtils_EncryptRejectsNullCryptor()
    {
        Assert.Throws<ArgumentNullException>(
            () => CryptoUtils.EncryptDecrypt(
                null!,
                CryptoMethod.ENCRYPT,
                "text",
                "salt"));
    }

    [Fact]
    public void CryptoUtils_RejectsUnknownOperation()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => CryptoUtils.EncryptDecrypt(
                new Base64Encryptor(),
                (CryptoMethod)999,
                "text",
                "salt"));
    }

    [Fact]
    public void CryptoUtils_RandomOutputsAreNotConstantAcrossReasonableSample()
    {
        var values = Enumerable.Range(0, 32)
            .Select(_ => CryptoUtils.CreateRandomString(32))
            .ToArray();

        Assert.Equal(
            values.Length,
            values.Distinct(StringComparer.Ordinal).Count());
    }
}
