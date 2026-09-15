using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Business.Core.ViewModel;
using System;
using System.Linq;
using Toolbox.Security;
using Toolbox.Security.Jwt;
using Toolbox.Security.Password;
using Xunit;

namespace Platform.Security.Tests;

public sealed class AuthOperationsTests
{
    [Fact]
    public void LoginUser_AcceptsModernPassword_AndReturnsSignedSession()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "operator@example.org", "A modern password! 2026", modernHash: true);
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = "OPERATOR@example.org",
            Password = "A modern password! 2026"
        });

        Assert.True(result.IsSuccess);
        Assert.NotNull(result.Data);
        Assert.Equal(user.UserName, result.Data.UserName);
        Assert.False(string.IsNullOrWhiteSpace(result.Data.SessionId));
        Assert.True(JwtUtils.ValidateToken(result.Data.AccessToken));
        Assert.True(JwtUtils.ValidateToken(result.Data.RefreshToken));
        Assert.NotEqual(result.Data.AccessToken, result.Data.RefreshToken);
        Assert.True(DateTimeOffset.TryParse(result.Data.SessionStart, out _));
    }

    [Fact]
    public void LoginUser_MigratesLegacySha1Hash_AfterSuccessfulAuthentication()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "legacy@example.org", "LegacyPassword1!", modernHash: false);
        var legacyHash = user.Password;
        Assert.False(PasswordUtils.IsModernHash(legacyHash));
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = user.UserName,
            Password = "LegacyPassword1!"
        });

        Assert.True(result.IsSuccess);
        var reloaded = db.UserAccounts.Single(x => x.Id == user.Id);
        Assert.NotEqual(legacyHash, reloaded.Password);
        Assert.True(PasswordUtils.IsModernHash(reloaded.Password));
        Assert.True(PasswordUtils.VerifyPassword("LegacyPassword1!", reloaded.Password));
        Assert.Equal(string.Empty, reloaded.Salt);
    }

    [Fact]
    public void LoginUser_DoesNotRehashLegacyPassword_WhenAuthenticationFails()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "legacy@example.org", "LegacyPassword1!", modernHash: false);
        var originalHash = user.Password;
        var originalSalt = user.Salt;
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = user.UserName,
            Password = "WrongPassword1!"
        });

        Assert.False(result.IsSuccess);
        Assert.Null(result.Data);
        var reloaded = db.UserAccounts.Single(x => x.Id == user.Id);
        Assert.Equal(originalHash, reloaded.Password);
        Assert.Equal(originalSalt, reloaded.Salt);
    }

    [Fact]
    public void LoginUser_RejectsInactiveAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "inactive@example.org", "A modern password! 2026", modernHash: true);
        user.IsActive = false;
        db.SaveChanges();
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = user.UserName,
            Password = "A modern password! 2026"
        });

        Assert.False(result.IsSuccess);
        Assert.Null(result.Data);
    }

    [Fact]
    public void LoginUser_RejectsDeletedAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "deleted@example.org", "A modern password! 2026", modernHash: true);
        user.IsDeleted = true;
        db.SaveChanges();
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = user.UserName,
            Password = "A modern password! 2026"
        });

        Assert.False(result.IsSuccess);
    }

    [Fact]
    public void LoginUser_RejectsUnknownUser_WithGenericCredentialError()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = "unknown@example.org",
            Password = "Some password! 2026"
        });

        Assert.False(result.IsSuccess);
        Assert.Equal("Wrong username or password", result.Message);
        Assert.Null(result.Data);
    }

    [Fact]
    public void LoginUser_RejectsNullModel_WithoutThrowing()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(null!);

        Assert.False(result.IsSuccess);
        Assert.Null(result.Data);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void LoginUser_RejectsBlankUsername(string username)
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = username,
            Password = "Some password! 2026"
        });

        Assert.False(result.IsSuccess);
    }

    [Fact]
    public void LoginUser_RejectsOverlongPassword_BeforeDatabaseAuthentication()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var operations = new AuthOperations(db);

        var result = operations.LoginUser(new UserAccountLoginViewModel
        {
            UserName = "operator@example.org",
            Password = new string('x', Configuration.MAX_PASSWORD_LENGTH + 1)
        });

        Assert.False(result.IsSuccess);
        Assert.Equal("Wrong username or password", result.Message);
    }

    [Fact]
    public void ChangePasswordFromProfile_ReplacesHash_AndClearsLegacySalt()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "operator@example.org", "Current password! 2026", modernHash: true);
        var oldHash = user.Password;
        var operations = new AuthOperations(db);

        var result = operations.ChangePasswordFromProfile(
            new UserAccountChangePasswordViewModel
            {
                OldPassword = "Current password! 2026",
                NewPassword = "Replacement password! 2026",
                NewPasswordRepeat = "Replacement password! 2026"
            },
            null!,
            new UserSessionViewModel { UserId = user.Id, UserName = user.UserName });

        Assert.True(result.IsSuccess);
        var reloaded = db.UserAccounts.Single(x => x.Id == user.Id);
        Assert.NotEqual(oldHash, reloaded.Password);
        Assert.True(PasswordUtils.IsModernHash(reloaded.Password));
        Assert.True(PasswordUtils.VerifyPassword("Replacement password! 2026", reloaded.Password));
        Assert.False(PasswordUtils.VerifyPassword("Current password! 2026", reloaded.Password));
        Assert.Equal(string.Empty, reloaded.Salt);
    }

    [Fact]
    public void ChangePasswordFromProfile_RejectsMismatchedConfirmation_WithoutMutatingAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "operator@example.org", "Current password! 2026", modernHash: true);
        var oldHash = user.Password;
        var operations = new AuthOperations(db);

        var result = operations.ChangePasswordFromProfile(
            new UserAccountChangePasswordViewModel
            {
                OldPassword = "Current password! 2026",
                NewPassword = "Replacement password! 2026",
                NewPasswordRepeat = "Different replacement! 2026"
            },
            null!,
            new UserSessionViewModel { UserId = user.Id });

        Assert.False(result.IsSuccess);
        Assert.Contains("uyuşmuyor", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(oldHash, db.UserAccounts.Single(x => x.Id == user.Id).Password);
    }

    [Fact]
    public void ChangePasswordFromProfile_RejectsWrongCurrentPassword_WithoutMutatingAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "operator@example.org", "Current password! 2026", modernHash: true);
        var oldHash = user.Password;
        var operations = new AuthOperations(db);

        var result = operations.ChangePasswordFromProfile(
            new UserAccountChangePasswordViewModel
            {
                OldPassword = "Wrong current password!",
                NewPassword = "Replacement password! 2026",
                NewPasswordRepeat = "Replacement password! 2026"
            },
            null!,
            new UserSessionViewModel { UserId = user.Id });

        Assert.False(result.IsSuccess);
        Assert.Equal(oldHash, db.UserAccounts.Single(x => x.Id == user.Id).Password);
    }

    [Fact]
    public void ChangePasswordFromProfile_RejectsWeakNewPassword_WithoutMutatingAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var user = AddExternalUser(db, "operator@example.org", "Current password! 2026", modernHash: true);
        var oldHash = user.Password;
        var operations = new AuthOperations(db);

        var result = operations.ChangePasswordFromProfile(
            new UserAccountChangePasswordViewModel
            {
                OldPassword = "Current password! 2026",
                NewPassword = "short",
                NewPasswordRepeat = "short"
            },
            null!,
            new UserSessionViewModel { UserId = user.Id });

        Assert.False(result.IsSuccess);
        Assert.Equal(oldHash, db.UserAccounts.Single(x => x.Id == user.Id).Password);
    }

    [Fact]
    public void ChangePasswordFromProfile_RejectsMissingSession()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        DisableLdap();
        var operations = new AuthOperations(db);

        var result = operations.ChangePasswordFromProfile(
            new UserAccountChangePasswordViewModel
            {
                OldPassword = "Current password! 2026",
                NewPassword = "Replacement password! 2026",
                NewPasswordRepeat = "Replacement password! 2026"
            },
            null!,
            null!);

        Assert.False(result.IsSuccess);
    }

    private static UserAccount AddExternalUser(
        BusinessContext db,
        string username,
        string password,
        bool modernHash)
    {
        var user = new UserAccount
        {
            UserName = username.ToLowerInvariant(),
            FirstName = "Platform",
            LastName = "Test",
            IsActive = true,
            IsDeleted = false,
            IsSuperUser = false,
            AccountType = UserAccountType.EXTERNAL,
            Roles = "platform-test"
        };
        user.SetCreate(-1);

        if (modernHash)
        {
            user.Password = PasswordUtils.HashPassword(password);
            user.Salt = string.Empty;
        }
        else
        {
            user.Salt = "legacy-test-salt";
            user.Password = PasswordUtils.Encrypt(password, user.Salt, new SHA1Encryptor());
        }

        db.UserAccounts.Add(user);
        db.SaveChanges();
        return user;
    }

    private static void DisableLdap()
    {
        Configuration.LDAP_DOMAIN = string.Empty;
        Configuration.LDAP_SERVER = string.Empty;
    }
}
