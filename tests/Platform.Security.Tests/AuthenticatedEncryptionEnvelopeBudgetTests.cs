using System;
using Toolbox.Security.Cryptography;
using Xunit;

namespace Platform.Security.Tests;

/// <summary>Adversarial envelope parsing and UTF-8 admission budgets.</summary>
public sealed class AuthenticatedEncryptionEnvelopeBudgetTests
{
    private const string Secret = "test-secret-with-sufficient-entropy";
    private const string Purpose = "platform-security-test";

    [Theory]
    [InlineData('A')]
    [InlineData('%')]
    public void OversizedEnvelope_RejectsBeforeSplit(char fill)
    {
        var envelope = "aes-gcm-v1$600000$" + new string(fill, 1_500_000);
        Assert.Throws<FormatException>(() =>
            AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
        Assert.False(AuthenticatedEncryptionUtils.IsModernEnvelope(envelope));
        Assert.True(AuthenticatedEncryptionUtils.NeedsReencryption(envelope));
        Assert.False(AuthenticatedEncryptionUtils.TryDecrypt(
            envelope, Secret, Purpose, out var plaintext));
        Assert.Null(plaintext);
    }

    [Fact]
    public void OversizedEncodedCiphertext_RejectsBeforeDecode()
    {
        var envelope = "aes-gcm-v1$600000$" +
            Convert.ToBase64String(new byte[16]) + "$" +
            Convert.ToBase64String(new byte[12]) + "$" +
            Convert.ToBase64String(new byte[16]) + "$" +
            new string('A', 1_400_000);
        Assert.Throws<FormatException>(() =>
            AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
    }

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public void OversizedFixedSegment_RejectsBeforeDecode(int segment)
    {
        var parts = new[]
        {
            "aes-gcm-v1", "600000",
            Convert.ToBase64String(new byte[16]),
            Convert.ToBase64String(new byte[12]),
            Convert.ToBase64String(new byte[16]),
            string.Empty
        };
        parts[segment] = new string('A', 1024);
        Assert.Throws<FormatException>(() =>
            AuthenticatedEncryptionUtils.Decrypt(
                string.Join('$', parts), Secret, Purpose));
    }

    [Fact]
    public void ExcessiveDelimiters_AreRejected()
    {
        var envelope = "aes-gcm-v1$600000$" + new string('$', 100_000);
        Assert.Throws<FormatException>(() =>
            AuthenticatedEncryptionUtils.Decrypt(envelope, Secret, Purpose));
    }

    [Fact]
    public void OversizedUnicodePlaintext_RejectsBeforeEncoding()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            AuthenticatedEncryptionUtils.Encrypt(
                new string('ğ', 524_289), Secret, Purpose));
    }

    [Fact]
    public void OversizedUnicodePurpose_RejectsBeforeEncoding()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            AuthenticatedEncryptionUtils.Decrypt(
                "bad", Secret, new string('ğ', 300)));
    }
}
