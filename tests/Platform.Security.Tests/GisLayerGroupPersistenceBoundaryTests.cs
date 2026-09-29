using Business.Core.Context;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisLayerGroupPersistenceBoundaryTests
{
    [Fact]
    public async Task CreateAsync_NormalizesTitle_AndPersistsAuditIdentity()
    {
        await using var context = CreateContext();
        var operations = new GisLayerGroupOperations(context);
        var input = new GisLayerGroup { Title = "  ulaşım katmanları  ", OrderPriority = 3 };

        var result = await operations.CreateAsync(input, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisLayerGroups.AsNoTracking().SingleAsync();
        Assert.Equal("Ulaşım Katmanları", stored.Title);
        Assert.Equal(3, stored.OrderPriority);
        Assert.False(string.IsNullOrWhiteSpace(stored.Guid));
    }

    [Fact]
    public async Task CreateAsync_PreCancelledRequest_DoesNotPersist()
    {
        await using var context = CreateContext();
        var operations = new GisLayerGroupOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.CreateAsync(new GisLayerGroup { Title = "Group" }, Session(), cancellation.Token));

        Assert.Empty(await context.GisLayerGroups.AsNoTracking().ToListAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task CreateAsync_BlankTitle_FailsClosed(string title)
    {
        await using var context = CreateContext();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.CreateAsync(new GisLayerGroup { Title = title }, Session());

        Assert.False(result.IsSuccess);
        Assert.Empty(await context.GisLayerGroups.AsNoTracking().ToListAsync());
    }

    [Fact]
    public async Task CreateAsync_OverlongTitle_FailsClosed()
    {
        await using var context = CreateContext();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.CreateAsync(new GisLayerGroup { Title = new string('x', 257) }, Session());

        Assert.False(result.IsSuccess);
        Assert.Empty(await context.GisLayerGroups.AsNoTracking().ToListAsync());
    }

    [Fact]
    public async Task CreateAsync_DuplicateNormalizedTitle_IsRejected()
    {
        await using var context = CreateContext();
        context.GisLayerGroups.Add(ExistingGroup("Ulaşım", 1));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.CreateAsync(new GisLayerGroup { Title = "  ULAŞIM  " }, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(1, await context.GisLayerGroups.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_MissingGroup_FailsWithoutInsert()
    {
        await using var context = CreateContext();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.UpdateAsync(new GisLayerGroup { Id = 404, Title = "Missing" }, Session());

        Assert.False(result.IsSuccess);
        Assert.Empty(await context.GisLayerGroups.AsNoTracking().ToListAsync());
    }

    [Fact]
    public async Task UpdateAsync_PreservesIdentity_AndUpdatesMutableFields()
    {
        await using var context = CreateContext();
        var existing = ExistingGroup("Original", 8);
        context.GisLayerGroups.Add(existing);
        await context.SaveChangesAsync();
        var guid = existing.Guid;
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.UpdateAsync(
            new GisLayerGroup { Id = existing.Id, Title = " Updated Group ", OrderPriority = 2 }, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisLayerGroups.AsNoTracking().SingleAsync();
        Assert.Equal(guid, stored.Guid);
        Assert.Equal("Updated Group", stored.Title);
        Assert.Equal(2, stored.OrderPriority);
    }

    [Fact]
    public async Task DeleteAsync_SoftDeletesGroup_AndMovesActiveLayersToUngrouped()
    {
        await using var context = CreateContext();
        var group = ExistingGroup("Delete", 1);
        context.GisLayerGroups.Add(group);
        await context.SaveChangesAsync();
        var layer = ExistingLayer("Layer", group.Id);
        context.GisLayers.Add(layer);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.DeleteAsync(new GisLayerGroup { Id = group.Id }, Session());

        Assert.True(result.IsSuccess);
        Assert.True((await context.GisLayerGroups.AsNoTracking().SingleAsync()).IsDeleted);
        Assert.Equal(-1, (await context.GisLayers.AsNoTracking().SingleAsync()).GisLayerGroupId);
    }

    [Fact]
    public async Task DeleteAsync_MissingGroup_FailsWithoutLayerMutation()
    {
        await using var context = CreateContext();
        var layer = ExistingLayer("Layer", 404);
        context.GisLayers.Add(layer);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.DeleteAsync(new GisLayerGroup { Id = 404 }, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(404, (await context.GisLayers.AsNoTracking().SingleAsync()).GisLayerGroupId);
    }

    [Fact]
    public async Task GetAllAsync_ExcludesDeleted_OrdersDeterministically_AndDoesNotTrack()
    {
        await using var context = CreateContext();
        var zulu = ExistingGroup("Zulu", 2);
        var alpha = ExistingGroup("Alpha", 1);
        var deleted = ExistingGroup("Deleted", 0);
        deleted.SetDelete(1);
        context.GisLayerGroups.AddRange(zulu, alpha, deleted);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.GetAllAsync();

        Assert.True(result.IsSuccess);
        Assert.Equal(new[] { "Alpha", "Zulu" }, result.Data.Select(x => x.Title).ToArray());
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetAllWithLayersForAdminAsync_ExcludesDeletedLayers_AndDoesNotTrack()
    {
        await using var context = CreateContext();
        var group = ExistingGroup("Group", 1);
        context.GisLayerGroups.Add(group);
        await context.SaveChangesAsync();
        var active = ExistingLayer("Active", group.Id);
        var deleted = ExistingLayer("Deleted", group.Id);
        deleted.SetDelete(1);
        context.GisLayers.AddRange(active, deleted);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.GetAllWithLayersForAdminAsync();

        Assert.True(result.IsSuccess);
        var returned = Assert.Single(result.Data);
        Assert.Equal("Active", Assert.Single(returned.Layers).Title);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetAllWithLayersForUserAsync_ExcludesDeletedGroupsAndLayers()
    {
        await using var context = CreateContext();
        var activeGroup = ExistingGroup("Active Group", 1);
        var deletedGroup = ExistingGroup("Deleted Group", 2);
        deletedGroup.SetDelete(1);
        context.GisLayerGroups.AddRange(activeGroup, deletedGroup);
        await context.SaveChangesAsync();
        context.GisLayers.AddRange(ExistingLayer("Visible", activeGroup.Id), ExistingLayer("Hidden Group Layer", deletedGroup.Id));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.GetAllWithLayersForUserAsync();

        Assert.True(result.IsSuccess);
        var returned = Assert.Single(result.Data);
        Assert.Equal("Active Group", returned.Title);
        Assert.Equal("Visible", Assert.Single(returned.Layers).Title);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task ReorderItemsAsync_MalformedPayload_FailsWithoutMutation()
    {
        await using var context = CreateContext();
        context.GisLayerGroups.Add(ExistingGroup("Stable", 7));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.ReorderItemsAsync("not-json");

        Assert.False(result.IsSuccess);
        Assert.Equal(7, (await context.GisLayerGroups.AsNoTracking().SingleAsync()).OrderPriority);
    }

    [Fact]
    public async Task ReorderItemsAsync_EmptyArray_FailsWithoutMutation()
    {
        await using var context = CreateContext();
        context.GisLayerGroups.Add(ExistingGroup("Stable", 5));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerGroupOperations(context);

        var result = await operations.ReorderItemsAsync("[]");

        Assert.False(result.IsSuccess);
        Assert.Equal(5, (await context.GisLayerGroups.AsNoTracking().SingleAsync()).OrderPriority);
    }

    private static GisLayerGroup ExistingGroup(string title, int priority)
    {
        var group = new GisLayerGroup { Title = title, OrderPriority = priority };
        group.SetCreate(1);
        return group;
    }

    private static GisLayer ExistingLayer(string title, int groupId)
    {
        var layer = new GisLayer
        {
            Title = title,
            Url = $"https://example.test/{title.Replace(' ', '-').ToLowerInvariant()}",
            Description = title,
            AdditionalInfo = string.Empty,
            SCUserName = string.Empty,
            SCPassword = string.Empty,
            GisLayerGroupId = groupId,
            StartupOpacity = 100,
            OrderPriority = 1
        };
        layer.SetCreate(1);
        return layer;
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"gis-layer-group-persistence-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }

    private static UserSessionViewModel Session() => new() { UserId = 1 };
}
