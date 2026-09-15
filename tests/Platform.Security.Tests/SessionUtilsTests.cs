using Api.Core.Base;
using Business.Core.Context;
using Business.Core.Model;
using System;
using System.Linq;
using Toolbox.Security.Jwt;
using Toolbox.Security.Url;
using Xunit;

namespace Platform.Security.Tests;

public sealed class SessionUtilsTests
{
    [Fact]
    public void GetUserAccountFromToken_ReturnsActiveAccount_ForValidBearerToken()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var account = AddAccount(db, isActive: true, isDeleted: false);
        var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(account.Guid));
        var token = JwtUtils.GenerateToken(encryptedGuid);
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + token);

        Assert.NotNull(resolved);
        Assert.Equal(account.Id, resolved!.Id);
        Assert.Equal(account.Guid, resolved.Guid);
        Assert.Equal(account.UserName, resolved.UserName);
    }

    [Fact]
    public void GetUserAccountFromToken_RejectsInactiveAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var account = AddAccount(db, isActive: false, isDeleted: false);
        var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(account.Guid));
        var token = JwtUtils.GenerateToken(encryptedGuid);
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + token);

        Assert.Null(resolved);
    }

    [Fact]
    public void GetUserAccountFromToken_RejectsDeletedAccount()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var account = AddAccount(db, isActive: true, isDeleted: true);
        var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(account.Guid));
        var token = JwtUtils.GenerateToken(encryptedGuid);
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + token);

        Assert.Null(resolved);
    }

    [Fact]
    public void GetUserAccountFromToken_RejectsUnknownGuid()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.NewGuid());
        var token = JwtUtils.GenerateToken(encryptedGuid);
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + token);

        Assert.Null(resolved);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Bearer")]
    [InlineData("Basic token")]
    [InlineData("Bearer one two")]
    public void GetUserAccountFromToken_RejectsMalformedAuthorizationHeader(string? header)
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken(header!);

        Assert.Null(resolved);
    }

    [Fact]
    public void GetUserAccountFromToken_RejectsTamperedJwt()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var account = AddAccount(db, isActive: true, isDeleted: false);
        var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(account.Guid));
        var token = JwtUtils.GenerateToken(encryptedGuid);
        var tokenParts = token.Split('.');
        tokenParts[2] = (tokenParts[2][0] == 'A' ? 'B' : 'A') + tokenParts[2].Substring(1);
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + string.Join('.', tokenParts));

        Assert.Null(resolved);
    }

    [Fact]
    public void GetUserAccountFromToken_RejectsTokenSignedBeforeKeyRotation()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var account = AddAccount(db, isActive: true, isDeleted: false);
        var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(account.Guid));
        var token = JwtUtils.GenerateToken(encryptedGuid);
        environment.SetJwtConfiguration();
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + token);

        Assert.Null(resolved);
    }

    [Fact]
    public void GetUserAccountFromToken_RejectsSignedToken_WhenSubjectCannotBeDecodedAsGuid()
    {
        using var environment = new TestEnvironment();
        using var db = environment.CreateDbContext();
        var token = JwtUtils.GenerateToken("not-a-valid-encrypted-guid");
        var sessionUtils = new SessionUtils(db);

        var resolved = sessionUtils.getUserAccountFromToken("Bearer " + token);

        Assert.Null(resolved);
    }

    [Fact]
    public void Constructor_RejectsNullDbContext()
    {
        Assert.Throws<ArgumentNullException>(() => new SessionUtils(null!));
    }

    private static UserAccount AddAccount(BusinessContext db, bool isActive, bool isDeleted)
    {
        var account = new UserAccount
        {
            UserName = "session-test@example.org",
            FirstName = "Session",
            LastName = "Test",
            Password = "not-used",
            Salt = string.Empty,
            AccountType = UserAccountType.EXTERNAL,
            IsActive = isActive,
            IsDeleted = isDeleted,
            Roles = string.Empty
        };
        account.SetCreate(-1);
        account.IsDeleted = isDeleted;

        db.UserAccounts.Add(account);
        db.SaveChanges();
        return db.UserAccounts.Single(x => x.Id == account.Id);
    }
}
