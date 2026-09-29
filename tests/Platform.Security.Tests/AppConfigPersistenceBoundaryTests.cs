using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class AppConfigPersistenceBoundaryTests
{
    [Fact]
    public async Task GetConfigAsync_MissingKey_ReturnsDeterministicDefaultWithoutPersistence()
    {
        await using var context = CreateContext();
        var operations = new AppConfigOperations(context);

        var result = await operations.GetConfigAsync("  map.settings  ");

        Assert.True(result.IsSuccess);
        Assert.NotNull(result.Data);
        Assert.Equal("map.settings", result.Data.ConfigKey);
        Assert.Equal("{}", result.Data.ConfigValue);
        Assert.Equal(0, await context.AppConfigs.CountAsync());
    }

    [Fact]
    public async Task GetConfigAsync_WhitespaceKey_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new AppConfigOperations(context);

        var result = await operations.GetConfigAsync("   ");

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.AppConfigs.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_PreCancelledRequest_DoesNotPersist()
    {
        await using var context = CreateContext();
        var operations = new AppConfigOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.UpdateAsync(
                new AppConfig { ConfigKey = "map.settings", ConfigValue = "{\"enabled\":true}" },
                Session(),
                cancellation.Token));

        Assert.Equal(0, await context.AppConfigs.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_MissingKey_CreatesNormalizedRecord()
    {
        await using var context = CreateContext();
        var operations = new AppConfigOperations(context);

        var result = await operations.UpdateAsync(
            new AppConfig { ConfigKey = "  map.settings  ", ConfigValue = "{\"enabled\":true}" },
            Session());

        Assert.True(result.IsSuccess);
        var stored = await context.AppConfigs.SingleAsync();
        Assert.Equal("map.settings", stored.ConfigKey);
        Assert.Equal("{\"enabled\":true}", stored.ConfigValue);
    }

    [Fact]
    public async Task UpdateAsync_ExistingKey_UpdatesWithoutDuplicate()
    {
        await using var context = CreateContext();
        context.AppConfigs.Add(ExistingConfig("map.settings", "{\"enabled\":false}"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new AppConfigOperations(context);
        var result = await operations.UpdateAsync(
            new AppConfig { ConfigKey = "map.settings", ConfigValue = "{\"enabled\":true}" },
            Session());

        Assert.True(result.IsSuccess);
        Assert.Equal(1, await context.AppConfigs.CountAsync());
        Assert.Equal("{\"enabled\":true}", (await context.AppConfigs.SingleAsync()).ConfigValue);
    }

    [Fact]
    public async Task CreateAsync_DuplicateActiveKey_IsRejectedWithoutSecondRecord()
    {
        await using var context = CreateContext();
        context.AppConfigs.Add(ExistingConfig("map.settings", "{}"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new AppConfigOperations(context);
        var result = await operations.CreateAsync(
            new AppConfig { ConfigKey = "map.settings", ConfigValue = "{\"changed\":true}" },
            Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(1, await context.AppConfigs.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_NullConfigValue_IsRejectedWithoutPersistence()
    {
        await using var context = CreateContext();
        var operations = new AppConfigOperations(context);

        var result = await operations.UpdateAsync(
            new AppConfig { ConfigKey = "map.settings", ConfigValue = null! },
            Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.AppConfigs.CountAsync());
    }

    [Fact]
    public async Task GetByKeyAsync_DoesNotTrackReadOnlyEntity()
    {
        await using var context = CreateContext();
        context.AppConfigs.Add(ExistingConfig("map.settings", "{}"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new AppConfigOperations(context);
        var result = await operations.GetByKeyAsync("map.settings");

        Assert.NotNull(result);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    private static AppConfig ExistingConfig(string key, string value)
    {
        var config = new AppConfig
        {
            ConfigKey = key,
            ConfigValue = value
        };
        config.SetCreate(1);
        return config;
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"app-config-boundary-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }

    private static UserSessionViewModel Session() => new UserSessionViewModel
    {
        UserId = 1
    };
}
