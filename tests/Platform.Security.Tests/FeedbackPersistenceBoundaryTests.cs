using Business.Core.Context;
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

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.CreateAsync(ValidFeedback(), cancellation.Token));

        Assert.Equal(0, await context.Feedbacks.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_WhitespaceRequiredField_IsRejectedWithoutPersistence()
    {
        await using var context = CreateContext();
        var operations = new FeedbackOperations(context);
        var model = ValidFeedback();
        model.Description = "   ";

        var result = await operations.CreateAsync(model);

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.Feedbacks.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_UnknownFeedbackType_IsRejectedWithoutPersistence()
    {
        await using var context = CreateContext();
        var operations = new FeedbackOperations(context);
        var model = ValidFeedback();
        model.FeedbackType = Int32.MaxValue;

        var result = await operations.CreateAsync(model);

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.Feedbacks.CountAsync());
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"feedback-boundary-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }

    private static FeedbackViewModel ValidFeedback()
    {
        return new FeedbackViewModel
        {
            City = "Ankara",
            Country = "Türkiye",
            Description = "Harita geri bildirimi",
            Email = "test@example.invalid",
            FullName = "Test Kullanıcı",
            Address = "Test adresi",
            FeedbackType = 1
        };
    }
}
