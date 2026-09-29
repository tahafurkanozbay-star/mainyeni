using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ClientLogPersistenceBoundaryTests
{
    [Fact]
    public async Task CreateAsync_NormalizesInputAndCreatesAuditIdentity()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);

        var result = await operations.CreateAsync(
            "  İçerik arama  ",
            "  Firefox  ",
            "  Linux  ",
            "  Desktop  ",
            "  127.0.0.1  ",
            "  {\"searchText\":\"park\"}  ");

        Assert.True(result.IsSuccess);
        var stored = await context.ClientLogs.SingleAsync();
        Assert.Equal("İçerik arama", stored.LogType);
        Assert.Equal("Firefox", stored.Browser);
        Assert.Equal("Linux", stored.Os);
        Assert.Equal("Desktop", stored.Device);
        Assert.Equal("127.0.0.1", stored.Ip);
        Assert.Equal("{\"searchText\":\"park\"}", stored.Details);
        Assert.False(string.IsNullOrWhiteSpace(stored.Guid));
        Assert.True(System.Guid.TryParse(stored.Guid, out _));
        Assert.True(stored.CreateDate > 0);
    }

    [Fact]
    public async Task CreateAsync_PreCancelledRequest_DoesNotPersist()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.CreateAsync("view", "browser", "os", "device", "ip", "{}", cancellation.Token));

        Assert.Equal(0, await context.ClientLogs.CountAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task CreateAsync_BlankLogType_FailsClosed(string logType)
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);

        var result = await operations.CreateAsync(logType, "browser", "os", "device", "ip", "{}");

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.ClientLogs.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_OverlongLogType_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);

        var result = await operations.CreateAsync(new string('x', 129), "browser", "os", "device", "ip", "{}");

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.ClientLogs.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_OverlongMetadata_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);

        var result = await operations.CreateAsync("view", new string('b', 513), "os", "device", "ip", "{}");

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.ClientLogs.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_OverlongIp_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);

        var result = await operations.CreateAsync("view", "browser", "os", "device", new string('1', 129), "{}");

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.ClientLogs.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_OverlongDetails_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);

        var result = await operations.CreateAsync("view", "browser", "os", "device", "ip", new string('d', 32 * 1024 + 1));

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.ClientLogs.CountAsync());
    }

    [Fact]
    public async Task GetStatisticsAsync_ReturnsBoundedDeterministicOrder()
    {
        await using var context = CreateContext();
        context.ClientLogs.AddRange(
            Log("beta"),
            Log("alpha"),
            Log("beta"),
            Log("alpha"),
            Log("gamma"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new ClientLogOperations(context);
        var result = await operations.GetStatisticsAsync();

        Assert.Collection(
            result,
            item => { Assert.Equal("alpha", item.name); Assert.Equal(2, item.value); },
            item => { Assert.Equal("beta", item.name); Assert.Equal(2, item.value); },
            item => { Assert.Equal("gamma", item.name); Assert.Equal(1, item.value); });
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetStatisticsAsync_LimitsCardinalityToTwentyRows()
    {
        await using var context = CreateContext();
        context.ClientLogs.AddRange(Enumerable.Range(0, 25).Select(index => Log($"type-{index:00}")));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new ClientLogOperations(context);
        var result = await operations.GetStatisticsAsync();

        Assert.Equal(20, result.Count);
        Assert.Equal("type-00", result[0].name);
        Assert.Equal("type-19", result[19].name);
    }

    [Fact]
    public async Task GetStatisticsAsync_PreCancelledRequest_StopsBeforeQuery()
    {
        await using var context = CreateContext();
        var operations = new ClientLogOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.GetStatisticsAsync(cancellation.Token));
    }

    private static ClientLog Log(string type) => new()
    {
        Guid = System.Guid.NewGuid().ToString(),
        CreateDate = 1,
        LogType = type,
        Details = "{}",
        Browser = string.Empty,
        Device = string.Empty,
        Os = string.Empty,
        Ip = string.Empty
    };

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"client-log-boundary-{System.Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }
}
