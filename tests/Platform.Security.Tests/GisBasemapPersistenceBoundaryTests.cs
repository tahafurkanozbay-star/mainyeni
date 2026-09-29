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

public sealed class GisBasemapPersistenceBoundaryTests
{
    [Fact]
    public async Task CreateAsync_NormalizesInput_AndPersistsAuditMetadata()
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);

        var result = await operations.CreateAsync(new GisBasemapLayer
        {
            Title = "  şehir haritası  ",
            Url = "  https://example.test/arcgis/rest/services/base/MapServer  ",
            Description = "  açıklama  ",
            RequiresSC = false,
            SCUserName = "must-not-survive",
            SCPassword = "must-not-survive"
        }, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisBasemapLayers.SingleAsync();
        Assert.Equal("Şehir Haritası", stored.Title);
        Assert.Equal("https://example.test/arcgis/rest/services/base/MapServer", stored.Url);
        Assert.Equal("açıklama", stored.Description);
        Assert.Equal(string.Empty, stored.ImageUrl);
        Assert.Equal(string.Empty, stored.AdditionalInfo);
        Assert.Equal(string.Empty, stored.SCUserName);
        Assert.Equal(string.Empty, stored.SCPassword);
        Assert.False(string.IsNullOrWhiteSpace(stored.Guid));
    }

    [Fact]
    public async Task CreateAsync_NullPersistenceOptionals_AreCanonicalizedToEmptyStrings()
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);
        var layer = new GisBasemapLayer
        {
            Title = "Basemap",
            Url = "https://example.test/base",
            Description = null,
            ImageUrl = null,
            AdditionalInfo = null,
            RequiresSC = false,
            SCUserName = null,
            SCPassword = null
        };

        var result = await operations.CreateAsync(layer, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisBasemapLayers.AsNoTracking().SingleAsync();
        Assert.Equal(string.Empty, stored.Description);
        Assert.Equal(string.Empty, stored.ImageUrl);
        Assert.Equal(string.Empty, stored.AdditionalInfo);
        Assert.Equal(string.Empty, stored.SCUserName);
        Assert.Equal(string.Empty, stored.SCPassword);
    }

    [Fact]
    public async Task CreateAsync_PreCancelledRequest_DoesNotPersist()
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operations.CreateAsync(
            ValidLayer(), Session(), cancellation.Token));

        Assert.Empty(await context.GisBasemapLayers.ToListAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-url")]
    [InlineData("javascript:alert(1)")]
    public async Task CreateAsync_InvalidUrl_FailsClosed(string url)
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);
        var layer = ValidLayer();
        layer.Url = url;

        var result = await operations.CreateAsync(layer, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.GisBasemapLayers.CountAsync());
    }

    [Fact]
    public async Task CreateAsync_SecureConnection_RequiresCredentials()
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);
        var layer = ValidLayer();
        layer.RequiresSC = true;
        layer.SCUserName = "   ";
        layer.SCPassword = "secret";

        var result = await operations.CreateAsync(layer, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.GisBasemapLayers.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_MissingEntity_FailsClosedWithoutInsert()
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);
        var layer = ValidLayer();
        layer.Id = 404;

        var result = await operations.UpdateAsync(layer, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.GisBasemapLayers.CountAsync());
    }

    [Fact]
    public async Task UpdateAsync_ExistingEntity_UpdatesMutableFieldsOnly()
    {
        await using var context = CreateContext();
        var existing = ExistingLayer("Original", "https://example.test/original");
        existing.AdditionalInfo = "server-owned";
        context.GisBasemapLayers.Add(existing);
        await context.SaveChangesAsync();
        var originalGuid = existing.Guid;
        context.ChangeTracker.Clear();

        var operations = new GisBasemapLayerOperations(context);
        var update = ValidLayer();
        update.Id = existing.Id;
        update.Title = "  Updated  ";
        update.Url = " https://example.test/updated ";
        update.AdditionalInfo = "must-not-overwrite";
        update.RequiresSC = true;
        update.SCUserName = "  service-user  ";
        update.SCPassword = "  service-password  ";

        var result = await operations.UpdateAsync(update, Session());

        Assert.True(result.IsSuccess);
        var stored = await context.GisBasemapLayers.AsNoTracking().SingleAsync();
        Assert.Equal(originalGuid, stored.Guid);
        Assert.Equal("Updated", stored.Title);
        Assert.Equal("https://example.test/updated", stored.Url);
        Assert.Equal("server-owned", stored.AdditionalInfo);
        Assert.Equal("service-user", stored.SCUserName);
        Assert.Equal("service-password", stored.SCPassword);
    }

    [Fact]
    public async Task DeleteAsync_SoftDeletesExistingEntity()
    {
        await using var context = CreateContext();
        var existing = ExistingLayer("Delete me", "https://example.test/delete");
        context.GisBasemapLayers.Add(existing);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new GisBasemapLayerOperations(context);
        var result = await operations.DeleteAsync(existing.Id, Session());

        Assert.True(result.IsSuccess);
        Assert.True((await context.GisBasemapLayers.AsNoTracking().SingleAsync()).IsDeleted);
    }

    [Fact]
    public async Task DeleteAsync_UnknownId_IsIdempotentFailure()
    {
        await using var context = CreateContext();
        var operations = new GisBasemapLayerOperations(context);

        var result = await operations.DeleteAsync(999, Session());

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.GisBasemapLayers.CountAsync());
    }

    [Fact]
    public async Task GetAllAsync_ReturnsOnlyActiveRows_InDeterministicOrder_WithoutTracking()
    {
        await using var context = CreateContext();
        var z = ExistingLayer("Zulu", "https://example.test/zulu");
        var a = ExistingLayer("Alpha", "https://example.test/alpha");
        var deleted = ExistingLayer("Deleted", "https://example.test/deleted");
        deleted.SetDelete(1);
        context.GisBasemapLayers.AddRange(z, a, deleted);
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();

        var operations = new GisBasemapLayerOperations(context);
        var result = await operations.GetAllAsync();

        Assert.True(result.IsSuccess);
        Assert.Equal(new[] { "Alpha", "Zulu" }, result.Data.Select(x => x.Title).ToArray());
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetLayerByUrlAsync_RequiresExactNormalizedIdentity_NotSubstringAlias()
    {
        await using var context = CreateContext();
        context.GisBasemapLayers.Add(ExistingLayer(
            "Base",
            "https://example.test/arcgis/rest/services/base/MapServer"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisBasemapLayerOperations(context);

        var exact = await operations.GetLayerByUrlAsync(
            "  https://example.test/arcgis/rest/services/base/MapServer  ");
        var parent = await operations.GetLayerByUrlAsync(
            "https://example.test/arcgis/rest/services/base");

        Assert.NotNull(exact);
        Assert.Null(parent);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task GetByGuidAsync_IsNoTracking_AndExcludesDeletedRows()
    {
        await using var context = CreateContext();
        var active = ExistingLayer("Active", "https://example.test/active");
        var deleted = ExistingLayer("Deleted", "https://example.test/deleted");
        deleted.SetDelete(1);
        context.GisBasemapLayers.AddRange(active, deleted);
        await context.SaveChangesAsync();
        var activeGuid = active.Guid;
        var deletedGuid = deleted.Guid;
        context.ChangeTracker.Clear();
        var operations = new GisBasemapLayerOperations(context);

        var found = await operations.GetByGuidAsync(activeGuid);
        var hidden = await operations.GetByGuidAsync(deletedGuid);

        Assert.NotNull(found);
        Assert.Null(hidden);
        Assert.Empty(context.ChangeTracker.Entries());
    }

    [Fact]
    public async Task BuiltinBasemapList_AppendsCanonicalBuiltins_AfterPersistedRows()
    {
        await using var context = CreateContext();
        context.GisBasemapLayers.Add(ExistingLayer("Custom", "https://example.test/custom"));
        await context.SaveChangesAsync();
        context.ChangeTracker.Clear();
        var operations = new GisBasemapLayerOperations(context);

        var result = await operations.GetAllWithBuiltinBasemapListAsync();

        Assert.True(result.IsSuccess);
        Assert.Equal("Custom", result.Data[0].Title);
        Assert.Contains(result.Data, x => x.Title == "topo");
        Assert.Contains(result.Data, x => x.Title == "streets-navigation-vector");
        Assert.Empty(context.ChangeTracker.Entries());
    }

    private static GisBasemapLayer ValidLayer() => new()
    {
        Title = "Basemap",
        Url = "https://example.test/arcgis/rest/services/base/MapServer",
        Description = "description"
    };

    private static GisBasemapLayer ExistingLayer(string title, string url)
    {
        var layer = new GisBasemapLayer
        {
            Title = title,
            Url = url,
            Description = title,
            AdditionalInfo = string.Empty,
            ImageUrl = string.Empty,
            SCUserName = string.Empty,
            SCPassword = string.Empty
        };
        layer.SetCreate(1);
        return layer;
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"basemap-persistence-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }

    private static UserSessionViewModel Session() => new() { UserId = 1 };
}
