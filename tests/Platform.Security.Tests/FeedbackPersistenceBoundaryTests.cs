using Business._Base;
using Business.Core.Context;
using Business.Core.ViewModel;
using Business.Extensions.FeedbackService.Model;
using Business.Extensions.FeedbackService.Operations;
using Business.Extensions.FeedbackService.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class FeedbackPersistenceBoundaryTests
{
    [Fact]
    public async Task CreateAsync_PreCancelledRequest_DoesNotPersist()
    {
        await using var context = CreateContext();
        var operations = new FeedbackOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operations.CreateAsync(ValidCreate(), cancellation.Token));
        Assert.Equal(0, await context.Feedbacks.CountAsync());
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task CreateAsync_TrimsAndPersistsBoundedFields()
    {
        await using var context = CreateContext();
        var input = ValidCreate();
        input.City = "  İstanbul  "; input.Country = "  Türkiye  "; input.Description = "  Açıklama  ";
        input.Email = "  user@example.test  "; input.FullName = "  Test Kullanıcı  "; input.Address = "  Test adresi  ";
        input.Browser = "  browser  "; input.Device = "  device  "; input.Os = "  os  "; input.Ip = "  127.0.0.1  ";
        var result = await new FeedbackOperations(context).CreateAsync(input);
        Assert.True(result.IsSuccess);
        var persisted = await context.Feedbacks.SingleAsync();
        Assert.Equal("İstanbul", persisted.City); Assert.Equal("Türkiye", persisted.Country); Assert.Equal("Açıklama", persisted.Description);
        Assert.Equal("user@example.test", persisted.Email); Assert.Equal("Test Kullanıcı", persisted.FullName); Assert.Equal("Test adresi", persisted.Address);
        Assert.Equal("browser", persisted.Browser); Assert.Equal("device", persisted.Device); Assert.Equal("os", persisted.Os); Assert.Equal("127.0.0.1", persisted.Ip);
        Assert.Equal(FeedbackStatus.List[0].Id, persisted.Status); Assert.Equal(FeedbackActions.List[0].Id, persisted.ActionTaken);
        Assert.Equal(persisted.CreateDate, persisted.UpdateDate); Assert.Equal(DateTimeKind.Utc, persisted.CreateDate.Kind);
    }

    [Theory]
    [InlineData("city")]
    [InlineData("country")]
    [InlineData("description")]
    [InlineData("email")]
    [InlineData("name")]
    [InlineData("address")]
    public async Task CreateAsync_BlankRequiredField_FailsClosed(string field)
    {
        await using var context = CreateContext(); var input = ValidCreate();
        switch (field) { case "city": input.City = "   "; break; case "country": input.Country = "   "; break; case "description": input.Description = "   "; break; case "email": input.Email = "   "; break; case "name": input.FullName = "   "; break; case "address": input.Address = "   "; break; }
        var result = await new FeedbackOperations(context).CreateAsync(input);
        Assert.False(result.IsSuccess); Assert.Equal(0, await context.Feedbacks.CountAsync());
    }

    [Theory]
    [InlineData("city", 129)] [InlineData("country", 129)] [InlineData("description", 8001)] [InlineData("email", 321)] [InlineData("name", 257)]
    [InlineData("address", 2049)] [InlineData("browser", 1025)] [InlineData("device", 1025)] [InlineData("os", 1025)] [InlineData("ip", 65)]
    public async Task CreateAsync_OverlongField_FailsClosed(string field, int length)
    {
        await using var context = CreateContext(); var input = ValidCreate(); var value = new string('x', length);
        switch (field) { case "city": input.City = value; break; case "country": input.Country = value; break; case "description": input.Description = value; break; case "email": input.Email = value; break; case "name": input.FullName = value; break; case "address": input.Address = value; break; case "browser": input.Browser = value; break; case "device": input.Device = value; break; case "os": input.Os = value; break; case "ip": input.Ip = value; break; }
        var result = await new FeedbackOperations(context).CreateAsync(input);
        Assert.False(result.IsSuccess); Assert.Equal(0, await context.Feedbacks.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_InvalidFeedbackType_FailsClosed()
    {
        await using var context = CreateContext(); var input = ValidCreate(); input.FeedbackType = Int32.MaxValue;
        var result = await new FeedbackOperations(context).CreateAsync(input);
        Assert.False(result.IsSuccess); Assert.Equal(0, await context.Feedbacks.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_PreCancelledRequest_DoesNotMutateRecord()
    {
        await using var context = CreateContext(); var model = ExistingFeedback(); context.Feedbacks.Add(model); await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new FeedbackOperations(context).UpdateAsync(model.Id, FeedbackStatus.List[1].Id, FeedbackActions.List[1].Id, Session(), cancellation.Token));
        var persisted = await context.Feedbacks.AsNoTracking().SingleAsync(); Assert.Equal(FeedbackStatus.List[0].Id, persisted.Status); Assert.Equal(FeedbackActions.List[0].Id, persisted.ActionTaken);
    }

    [Fact]
    public async Task UpdateAsync_InvalidStatus_FailsClosedWithoutMutation()
    {
        await using var context = CreateContext(); var model = ExistingFeedback(); context.Feedbacks.Add(model); await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        var result = await new FeedbackOperations(context).UpdateAsync(model.Id, Int32.MaxValue, FeedbackActions.List[0].Id, Session());
        Assert.False(result.IsSuccess); Assert.Equal(FeedbackStatus.List[0].Id, (await context.Feedbacks.AsNoTracking().SingleAsync()).Status);
    }

    [Fact]
    public async Task UpdateAsync_InvalidAction_FailsClosedWithoutMutation()
    {
        await using var context = CreateContext(); var model = ExistingFeedback(); context.Feedbacks.Add(model); await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        var result = await new FeedbackOperations(context).UpdateAsync(model.Id, FeedbackStatus.List[0].Id, Int32.MaxValue, Session());
        Assert.False(result.IsSuccess); Assert.Equal(FeedbackActions.List[0].Id, (await context.Feedbacks.AsNoTracking().SingleAsync()).ActionTaken);
    }

    [Fact]
    public async Task UpdateAsync_NullSession_FailsClosedWithoutQuery()
    {
        await using var context = CreateContext(); var model = ExistingFeedback(); context.Feedbacks.Add(model); await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        var result = await new FeedbackOperations(context).UpdateAsync(model.Id, FeedbackStatus.List[1].Id, FeedbackActions.List[1].Id, null!);
        Assert.False(result.IsSuccess); Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task ListAsync_PreCancelledRequest_DoesNotMaterializeRows()
    {
        await using var context = CreateContext(); context.Feedbacks.Add(ExistingFeedback()); await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new FeedbackOperations(context).ListAsync(Search(1, 25), Session(), cancellation.Token));
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task ListAsync_OverlargePageNumber_FailsClosed()
    {
        await using var context = CreateContext(); var result = await new FeedbackOperations(context).ListAsync(Search(1_000_001, 25), Session());
        Assert.False(result.IsSuccess); Assert.NotNull(result.Data); Assert.Empty(result.Data.Data); Assert.Equal(0, result.Data.TotalRowCount);
    }

    [Fact]
    public async Task ListAsync_PageSizeAboveBudget_FallsBackToDefault()
    {
        await using var context = CreateContext();
        for (var i = 0; i < 40; i++) { var model = ExistingFeedback(); model.Email = $"user-{i}@example.test"; model.CreateDate = DateTime.UtcNow.AddMinutes(-i); model.UpdateDate = model.CreateDate; context.Feedbacks.Add(model); }
        await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        var result = await new FeedbackOperations(context).ListAsync(Search(1, Int32.MaxValue), Session());
        Assert.True(result.IsSuccess); Assert.Equal(25, result.Data.PageSize); Assert.Equal(25, result.Data.Data.Count); Assert.Equal(40, result.Data.TotalRowCount); Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task ListAsync_UsesStableIdTieBreakerForEqualTimestamps()
    {
        await using var context = CreateContext(); var timestamp = DateTime.UtcNow; var first = ExistingFeedback(); var second = ExistingFeedback(); first.CreateDate = timestamp; second.CreateDate = timestamp; first.UpdateDate = timestamp; second.UpdateDate = timestamp;
        context.Feedbacks.AddRange(first, second); await context.SaveChangesAsync(); context.ChangeTracker.Clear();
        var result = await new FeedbackOperations(context).ListAsync(Search(1, 25), Session());
        Assert.True(result.IsSuccess); Assert.Equal(2, result.Data.Data.Count); Assert.True(result.Data.Data[0].Id > result.Data.Data[1].Id);
    }

    [Fact]
    public async Task GetByIdAsync_InvalidId_FailsClosedWithoutTracking()
    {
        await using var context = CreateContext(); var result = await new FeedbackOperations(context).GetByIdAsync(0);
        Assert.False(result.IsSuccess); Assert.Null(result.Data); Assert.Empty(context.ChangeTracker.Entries());
    }

    private static FeedbackViewModel ValidCreate() => new() { FeedbackType = FeedbackTypes.List[0].Id, Description = "Açıklama", FullName = "Test Kullanıcı", Country = "Türkiye", City = "İstanbul", Email = "user@example.test", Address = "Test adresi", Ip = "127.0.0.1", Browser = "browser", Device = "device", Os = "os" };
    private static Feedback ExistingFeedback() { var now = DateTime.UtcNow; return new Feedback { FeedbackType = FeedbackTypes.List[0].Id, Description = "Açıklama", FullName = "Test Kullanıcı", Country = "Türkiye", City = "İstanbul", Email = $"user-{Guid.NewGuid():N}@example.test", Address = "Test adresi", Ip = "127.0.0.1", Browser = "browser", Device = "device", Os = "os", Status = FeedbackStatus.List[0].Id, ActionTaken = FeedbackActions.List[0].Id, CreateDate = now, UpdateDate = now, UpdatedBy = -1 }; }
    private static UserSessionViewModel Session() => new() { UserId = 42 };
    private static _BaseSearchViewModel Search(int pageNumber, int pageSize) => new() { PageNumber = pageNumber, PageSize = pageSize };
    private static BusinessContext CreateContext() { var options = new DbContextOptionsBuilder<BusinessContext>().UseInMemoryDatabase($"feedback-boundary-{Guid.NewGuid():N}").Options; return new BusinessContext(options); }
}
