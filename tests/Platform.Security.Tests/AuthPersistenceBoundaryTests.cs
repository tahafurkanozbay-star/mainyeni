using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Operations;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class AuthPersistenceBoundaryTests
{
    [Fact]
    public async Task LoginUserAsync_PreCancelledRequest_DoesNotTouchPersistence()
    {
        await using var context = CreateContext();
        var operations = new AuthOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.LoginUserAsync(
                new UserAccountLoginViewModel
                {
                    UserName = "user@example.invalid",
                    Password = "not-a-real-password"
                },
                cancellation.Token));

        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task LoginUserAsync_OverlongUsername_FailsClosedWithoutQueryMaterialization()
    {
        await using var context = CreateContext();
        var operations = new AuthOperations(context);

        var result = await operations.LoginUserAsync(new UserAccountLoginViewModel
        {
            UserName = new string('a', 321),
            Password = "not-a-real-password"
        });

        Assert.False(result.IsSuccess);
        Assert.Null(result.Data);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task LoginUserAsync_BlankUsername_FailsClosedWithoutPersistence()
    {
        await using var context = CreateContext();
        var operations = new AuthOperations(context);

        var result = await operations.LoginUserAsync(new UserAccountLoginViewModel
        {
            UserName = "   ",
            Password = "not-a-real-password"
        });

        Assert.False(result.IsSuccess);
        Assert.Null(result.Data);
        Assert.Equal(0, await context.UserAccounts.CountAsync());
    }

    [Fact]
    public async Task ChangePasswordFromProfileAsync_PreCancelledRequest_DoesNotTouchPersistence()
    {
        await using var context = CreateContext();
        var operations = new AuthOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.ChangePasswordFromProfileAsync(
                new UserAccountChangePasswordViewModel(),
                new ClientRequestInfo(),
                new UserSessionViewModel { UserId = 42 },
                cancellation.Token));

        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task ChangePasswordFromProfileAsync_NullSession_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new AuthOperations(context);

        var result = await operations.ChangePasswordFromProfileAsync(
            new UserAccountChangePasswordViewModel(),
            new ClientRequestInfo(),
            null!);

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.UserAccounts.CountAsync());
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"auth-boundary-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }
}
