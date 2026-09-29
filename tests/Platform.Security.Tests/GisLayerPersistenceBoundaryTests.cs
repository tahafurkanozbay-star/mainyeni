using Business.Core.Context;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Business.Extensions.Gis.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisLayerPersistenceBoundaryTests
{
    [Fact]
    public async Task CreateAsync_NormalizesInput_AndPersistsAuditMetadata()
    {
        await using var context = CreateContext();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.Title = "  şehir katmanı  ";
        input.Url = " https://example.test/arcgis/rest/services/city/MapServer ";
        input.Description = "  açıklama  ";
        input.AdditionalInfo = "  metadata  ";
        input.SCUserName = "must-clear";
        input.SCPassword = "must-clear";

        var result = await operations.CreateAsync(input, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisLayers.AsNoTracking().SingleAsync();
        Assert.Equal("Şehir Katmanı", stored.Title);
        Assert.Equal("https://example.test/arcgis/rest/services/city/MapServer", stored.Url);
        Assert.Equal("açıklama", stored.Description);
        Assert.Equal("metadata", stored.AdditionalInfo);
        Assert.Equal(string.Empty, stored.SCUserName);
        Assert.Equal(string.Empty, stored.SCPassword);
        Assert.False(string.IsNullOrWhiteSpace(stored.Guid));
    }

    [Fact]
    public async Task CreateAsync_PreCancelledRequest_DoesNotPersist()
    {
        await using var context = CreateContext();
        var operations = new GisLayerOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.CreateAsync(ValidLayer(), Session(), cancellation.Token));

        Assert.Empty(await context.GisLayers.ToListAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-url")]
    [InlineData("javascript:alert(1)")]
    [InlineData("file:///tmp/layer.json")]
    public async Task CreateAsync_InvalidOrUnsafeUrl_FailsClosed(string url)
    {
        await using var context = CreateContext();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.Url = url;

        var result = await operations.CreateAsync(input, Session());

        Assert.False(result.IsSuccess);
        Assert.Empty(await context.GisLayers.ToListAsync());
    }

    [Fact]
    public async Task CreateAsync_DuplicateNormalizedUrl_IsRejected()
    {
        await using var context = CreateContext();
        context.GisLayers.Add(ExistingLayer("Existing", "https://example.test/service"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.Url = " HTTPS://EXAMPLE.TEST/service/ ";

        var result = await operations.CreateAsync(input, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(1, await context.GisLayers.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_SecureConnectionRequiresBoundedCredentials()
    {
        await using var context = CreateContext();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.RequiresSC = true;
        input.SCUserName = "   ";
        input.SCPassword = "secret";

        var result = await operations.CreateAsync(input, Session());

        Assert.False(result.IsSuccess);
        Assert.Empty(await context.GisLayers.ToListAsync());
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(101)]
    public async Task CreateAsync_InvalidOpacity_IsRejected(int opacity)
    {
        await using var context = CreateContext();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.StartupOpacity = opacity;

        var result = await operations.CreateAsync(input, Session());

        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task UpdateAsync_MissingEntity_FailsClosedWithoutInsert()
    {
        await using var context = CreateContext();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.Id = 404;

        var result = await operations.UpdateAsync(input, Session());

        Assert.False(result.IsSuccess);
        Assert.Empty(await context.GisLayers.ToListAsync());
    }

    [Fact]
    public async Task UpdateAsync_PreservesIdentity_AndUpdatesMutableFields()
    {
        await using var context = CreateContext();
        var existing = ExistingLayer("Original", "https://example.test/original");
        context.GisLayers.Add(existing);
        await context.SaveChangesAsync();
        var guid = existing.Guid;
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);
        var input = ValidLayer();
        input.Id = existing.Id;
        input.Title = " Updated ";
        input.Url = "https://example.test/updated";
        input.RequiresSC = true;
        input.SCUserName = " service-user ";
        input.SCPassword = " service-password ";

        var result = await operations.UpdateAsync(input, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisLayers.AsNoTracking().SingleAsync();
        Assert.Equal(guid, stored.Guid);
        Assert.Equal("Updated", stored.Title);
        Assert.Equal("service-user", stored.SCUserName);
        Assert.Equal("service-password", stored.SCPassword);
    }

    [Fact]
    public async Task DeleteAsync_SoftDeletes_AndSecondDeleteFailsClosed()
    {
        await using var context = CreateContext();
        var existing = ExistingLayer("Delete", "https://example.test/delete");
        context.GisLayers.Add(existing);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);

        var first = await operations.DeleteAsync(existing.Id, Session());
        var second = await operations.DeleteAsync(existing.Id, Session());

        Assert.True(first.IsSuccess);
        Assert.False(second.IsSuccess);
        Assert.True((await context.GisLayers.AsNoTracking().SingleAsync()).IsDeleted);
    }

    [Fact]
    public async Task GetAllAsync_ExcludesDeletedRows_UsesDeterministicOrder_AndNoTracking()
    {
        await using var context = CreateContext();
        var zulu = ExistingLayer("Zulu", "https://example.test/zulu", 2);
        var alpha = ExistingLayer("Alpha", "https://example.test/alpha", 1);
        var deleted = ExistingLayer("Deleted", "https://example.test/deleted", 0);
        deleted.SetDelete(1);
        context.GisLayers.AddRange(zulu, alpha, deleted);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);

        var result = await operations.GetAllAsync();

        Assert.True(result.IsSuccess);
        Assert.Equal(new[] { "Alpha", "Zulu" }, result.Data.Select(x => x.Title).ToArray());
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetLayerByUrlAsync_UsesExactCanonicalIdentity_NotSubstringMatching()
    {
        await using var context = CreateContext();
        context.GisLayers.Add(ExistingLayer(
            "Layer", "https://example.test/arcgis/rest/services/city/MapServer"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);

        var exact = await operations.GetLayerByUrlAsync(
            " https://example.test/arcgis/rest/services/city/MapServer/ ");
        var parent = await operations.GetLayerByUrlAsync(
            "https://example.test/arcgis/rest/services/city");

        Assert.NotNull(exact);
        Assert.Null(parent);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetLayerByGuidAsync_ExcludesDeletedRows_AndDoesNotTrack()
    {
        await using var context = CreateContext();
        var active = ExistingLayer("Active", "https://example.test/active");
        var deleted = ExistingLayer("Deleted", "https://example.test/deleted");
        deleted.SetDelete(1);
        context.GisLayers.AddRange(active, deleted);
        await context.SaveChangesAsync();
        var activeGuid = active.Guid;
        var deletedGuid = deleted.Guid;
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);

        var found = await operations.GetLayerByGuidAsync(activeGuid);
        var hidden = await operations.GetLayerByGuidAsync(deletedGuid);

        Assert.NotNull(found);
        Assert.Null(hidden);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task ReorderAsync_MalformedPayload_FailsWithoutMutation()
    {
        await using var context = CreateContext();
        var existing = ExistingLayer("Existing", "https://example.test/existing", 7);
        context.GisLayers.Add(existing);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisLayerOperations(context);

        var result = await operations.ReOrderGisLayersAsync("not-json");

        Assert.False(result.IsSuccess);
        Assert.Equal(7, (await context.GisLayers.AsNoTracking().SingleAsync()).OrderPriority);
    }

    private static GisLayerAdminViewModel ValidLayer() => new()
    {
        Title = "Layer",
        Url = "https://example.test/arcgis/rest/services/layer/MapServer",
        Description = "description",
        AdditionalInfo = string.Empty,
        GisLayerGroupId = -1,
        StartupOpacity = 100,
        OrderPriority = 1,
        RequiresSC = false
    };

    private static GisLayer ExistingLayer(string title, string url, int priority = 1)
    {
        var layer = new GisLayer
        {
            Title = title,
            Url = url,
            Description = title,
            AdditionalInfo = string.Empty,
            SCUserName = string.Empty,
            SCPassword = string.Empty,
            GisLayerGroupId = -1,
            StartupOpacity = 100,
            OrderPriority = priority
        };
        layer.SetCreate(1);
        return layer;
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"gis-layer-persistence-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }

    private static UserSessionViewModel Session() => new() { UserId = 1 };
}
