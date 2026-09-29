using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class SystemOperationsBoundaryTests
{
    [Fact]
    public async Task IsDatabaseConnectionExistsAsync_InMemoryProvider_ReturnsTrueWithoutDisposingContext()
    {
        await using var context = CreateContext();
        var operations = new SystemOperations(context);

        var result = await operations.IsDatabaseConnectionExistsAsync();

        Assert.True(result);
        Assert.NotNull(context.Model);
    }

    [Fact]
    public async Task IsDatabaseConnectionExistsAsync_PreCancelledRequest_ThrowsCancellation()
    {
        await using var context = CreateContext();
        var operations = new SystemOperations(context);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            operations.IsDatabaseConnectionExistsAsync(cancellation.Token));
    }

    [Fact]
    public async Task CreateConfigurationServicesAsync_ParsesQuotedCsvAndNormalizesFields()
    {
        await using var context = CreateContext();
        var path = await WriteTempAsync("  ulaşım  ,\"Durak, Ana\",https://example.test/arcgis/rest/services/stops,\"Açıklama, detay\"");
        try
        {
            var result = await new SystemOperations(context).CreateConfigurationServicesAsync(path);

            Assert.True(result.IsSuccess);
            var service = await context.GisConfigServices.SingleAsync();
            Assert.Equal("ulaşım", service.Category);
            Assert.Equal("Durak, Ana", service.Title);
            Assert.Equal("https://example.test/arcgis/rest/services/stops", service.Url.TrimEnd('/'));
            Assert.Equal("Açıklama, detay", service.Description);
            Assert.False(service.RequiresSC);
            Assert.False(string.IsNullOrWhiteSpace(service.Guid));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData("kategori,başlık,javascript:alert(1),açıklama")]
    [InlineData("kategori,başlık,file:///tmp/service,açıklama")]
    [InlineData("kategori,başlık,relative/path,açıklama")]
    public async Task CreateConfigurationServicesAsync_RejectsUnsafeOrRelativeUrls(string line)
    {
        await using var context = CreateContext();
        var path = await WriteTempAsync(line);
        try
        {
            var result = await new SystemOperations(context).CreateConfigurationServicesAsync(path);

            Assert.False(result.IsSuccess);
            Assert.Equal(0, await context.GisConfigServices.CountAsync());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task CreateConfigurationServicesAsync_MalformedCsv_FailsClosedWithoutReplacingExistingRows()
    {
        await using var context = CreateContext();
        context.GisConfigServices.Add(new Business.Extensions.Gis.Model.GisConfigService
        {
            Guid = Guid.NewGuid().ToString(),
            CreateDate = 1,
            Category = "existing",
            Title = "existing",
            Url = "https://example.test/existing",
            Description = string.Empty,
            SCUserName = string.Empty,
            SCPassword = string.Empty,
            AdditionalInfo = string.Empty,
            SearchCategoryTitle = string.Empty,
            IdentifyLayers = string.Empty
        });
        await context.SaveChangesAsync();
        var path = await WriteTempAsync("category,\"unclosed,https://example.test/service,description");
        try
        {
            var result = await new SystemOperations(context).CreateConfigurationServicesAsync(path);

            Assert.False(result.IsSuccess);
            Assert.Equal(1, await context.GisConfigServices.CountAsync());
            Assert.Equal("existing", (await context.GisConfigServices.SingleAsync()).Category);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task CreateConfigurationServicesAsync_PreCancelledRequest_DoesNotReplaceRows()
    {
        await using var context = CreateContext();
        var path = await WriteTempAsync("category,title,https://example.test/service,description");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                new SystemOperations(context).CreateConfigurationServicesAsync(path, cancellation.Token));
            Assert.Equal(0, await context.GisConfigServices.CountAsync());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task CreateConfigurationServicesAsync_MissingFile_ReturnsError()
    {
        await using var context = CreateContext();
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".csv");

        var result = await new SystemOperations(context).CreateConfigurationServicesAsync(path);

        Assert.False(result.IsSuccess);
        Assert.Equal(0, await context.GisConfigServices.CountAsync());
    }

    [Fact]
    public async Task CreateMapConfigurationAsync_ReplacesDuplicateLegacyRowsWithSingleCanonicalValue()
    {
        await using var context = CreateContext();
        context.AppConfigs.AddRange(
            Config(Configuration.ConfigKey_GisMapConfig, "old-a"),
            Config(Configuration.ConfigKey_GisMapConfig, "old-b"),
            Config("other", "preserve"));
        await context.SaveChangesAsync();
        var path = await WriteTempAsync("{\"version\":2}");
        try
        {
            var result = await new SystemOperations(context).CreateMapConfigurationAsync(path);

            Assert.True(result.IsSuccess);
            var mapConfigs = await context.AppConfigs
                .Where(x => x.ConfigKey == Configuration.ConfigKey_GisMapConfig)
                .ToListAsync();
            Assert.Single(mapConfigs);
            Assert.Equal("{\"version\":2}", mapConfigs[0].ConfigValue);
            Assert.Equal(1, await context.AppConfigs.CountAsync(x => x.ConfigKey == "other"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task CreateMapConfigurationAsync_BlankFile_FailsClosedWithoutReplacingExistingValue()
    {
        await using var context = CreateContext();
        context.AppConfigs.Add(Config(Configuration.ConfigKey_GisMapConfig, "old"));
        await context.SaveChangesAsync();
        var path = await WriteTempAsync("   ");
        try
        {
            var result = await new SystemOperations(context).CreateMapConfigurationAsync(path);

            Assert.False(result.IsSuccess);
            Assert.Equal("old", (await context.AppConfigs.SingleAsync()).ConfigValue);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task CreateMapConfigurationAsync_PreCancelledRequest_PreservesExistingValue()
    {
        await using var context = CreateContext();
        context.AppConfigs.Add(Config(Configuration.ConfigKey_GisMapConfig, "old"));
        await context.SaveChangesAsync();
        var path = await WriteTempAsync("{\"version\":2}");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                new SystemOperations(context).CreateMapConfigurationAsync(path, cancellation.Token));
            Assert.Equal("old", (await context.AppConfigs.SingleAsync()).ConfigValue);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static AppConfig Config(string key, string value) => new()
    {
        Guid = Guid.NewGuid().ToString(),
        CreateDate = 1,
        ConfigKey = key,
        ConfigValue = value
    };

    private static async Task<string> WriteTempAsync(string content)
    {
        var path = Path.Combine(Path.GetTempPath(), $"platform-system-{Guid.NewGuid():N}.tmp");
        await File.WriteAllTextAsync(path, content);
        return path;
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase($"system-boundary-{Guid.NewGuid():N}")
            .Options;
        return new BusinessContext(options);
    }
}
