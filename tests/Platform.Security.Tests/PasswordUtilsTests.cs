using System;
using System.Globalization;
using Toolbox.Security.Password;
using Xunit;

namespace Platform.Security.Tests;

public sealed class PasswordUtilsTests
{
    [Fact]
    public void HashPassword_ProducesVersionedPbkdf2Payload()
    {
        var encoded = PasswordUtils.HashPassword("Correct Horse Battery Staple! 2026");
        var parts = encoded.Split('$');

        Assert.Equal(4, parts.Length);
        Assert.Equal("pbkdf2-sha256", parts[0]);
        Assert.Equal(600_000, int.Parse(parts[1], CultureInfo.InvariantCulture));
        Assert.Equal(16, Convert.FromBase64String(parts[2]).Length);
        Assert.Equal(32, Convert.FromBase64String(parts[3]).Length);
        Assert.True(PasswordUtils.IsModernHash(encoded));
        Assert.False(PasswordUtils.NeedsRehash(encoded));
    }

    [Fact]
    public void HashPassword_UsesRandomSalt()
    {
        const string password = "A sufficiently long password!";

        var first = PasswordUtils.HashPassword(password);
        var second = PasswordUtils.HashPassword(password);

        Assert.NotEqual(first, second);
        Assert.True(PasswordUtils.VerifyPassword(password, first));
        Assert.True(PasswordUtils.VerifyPassword(password, second));
    }

    [Fact]
    public void HashPassword_RejectsEmptyInput()
    {
        Assert.Throws<ArgumentException>(() => PasswordUtils.HashPassword(string.Empty));
    }

    [Fact]
    public void VerifyPassword_AcceptsCorrectPassword_AndRejectsWrongPassword()
    {
        const string password = "Enterprise-GIS password 2026!";
        var encoded = PasswordUtils.HashPassword(password);

        Assert.True(PasswordUtils.VerifyPassword(password, encoded));
        Assert.False(PasswordUtils.VerifyPassword(password + "x", encoded));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", "")]
    [InlineData("password", "")]
    [InlineData("", "pbkdf2-sha256$600000$AA==$AA==")]
    [InlineData("password", "legacy")]
    [InlineData("password", "pbkdf2-sha256")]
    [InlineData("password", "pbkdf2-sha256$600000$bad$bad")]
    public void VerifyPassword_ReturnsFalse_ForInvalidInputs(string? password, string? encoded)
    {
        Assert.False(PasswordUtils.VerifyPassword(password!, encoded!));
    }

    [Theory]
    [InlineData("pbkdf2-sha256$99999$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")]
    [InlineData("pbkdf2-sha256$2000001$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")]
    [InlineData("pbkdf2-sha256$not-a-number$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")]
    public void VerifyPassword_RejectsUnboundedOrInvalidIterationCounts(string encoded)
    {
        Assert.False(PasswordUtils.VerifyPassword("password", encoded));
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("legacy-hash", false)]
    [InlineData("pbkdf2-sha256$600000$salt$hash", true)]
    public void IsModernHash_DetectsOnlyVersionedPbkdf2(string? encoded, bool expected)
    {
        Assert.Equal(expected, PasswordUtils.IsModernHash(encoded!));
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("", true)]
    [InlineData("legacy-hash", true)]
    [InlineData("pbkdf2-sha256$100000$salt$hash", true)]
    [InlineData("pbkdf2-sha256$599999$salt$hash", true)]
    [InlineData("pbkdf2-sha256$600000$salt$hash", false)]
    [InlineData("pbkdf2-sha256$700000$salt$hash", false)]
    [InlineData("pbkdf2-sha256$invalid$salt$hash", true)]
    public void NeedsRehash_TracksCurrentPasswordWorkFactor(string? encoded, bool expected)
    {
        Assert.Equal(expected, PasswordUtils.NeedsRehash(encoded!));
    }

    [Theory]
    [InlineData("", PasswordUtils.PasswordScore.Blank)]
    [InlineData("a", PasswordUtils.PasswordScore.VeryWeak)]
    [InlineData("abcd", PasswordUtils.PasswordScore.VeryWeak)]
    [InlineData("abcdefgh", PasswordUtils.PasswordScore.Weak)]
    [InlineData("abcdefghijkl", PasswordUtils.PasswordScore.Medium)]
    [InlineData("Abcdefghijkl", PasswordUtils.PasswordScore.Strong)]
    [InlineData("Abcdefghijkl1", PasswordUtils.PasswordScore.VeryStrong)]
    [InlineData("Abcdefghijkl1!", PasswordUtils.PasswordScore.VeryStrong)]
    public void EvaluatePasswordStrength_UsesActualCharacterClasses(
        string password,
        PasswordUtils.PasswordScore expected)
    {
        Assert.Equal(expected, PasswordUtils.EvaluatePasswordStrength(password));
    }

    [Fact]
    public void VerifyPassword_RejectsTruncatedSalt()
    {
        var encoded = PasswordUtils.HashPassword("Long enough password! 123");
        var parts = encoded.Split('$');
        parts[2] = Convert.ToBase64String(new byte[4]);

        Assert.False(PasswordUtils.VerifyPassword("Long enough password! 123", string.Join('$', parts)));
    }

    [Fact]
    public void VerifyPassword_RejectsTruncatedHash()
    {
        var encoded = PasswordUtils.HashPassword("Long enough password! 123");
        var parts = encoded.Split('$');
        parts[3] = Convert.ToBase64String(new byte[8]);

        Assert.False(PasswordUtils.VerifyPassword("Long enough password! 123", string.Join('$', parts)));
    }
}
