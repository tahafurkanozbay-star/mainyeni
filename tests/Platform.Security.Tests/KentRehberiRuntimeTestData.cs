using Api.User.KentRehberi;
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Platform.Security.Tests;

internal static class KentRehberiRuntimeTestData
{
    public static KentRehberiOptions Options(
        Action<KentRehberiOptions>? configure = null)
    {
        var options = new KentRehberiOptions
        {
            Enabled = true,
            DefaultLimit = 50,
            MaxLimit = 200,
            MaxRadiusMeters = 50_000,
            CommandTimeoutSeconds = 8,
            ConnectionTimeoutSeconds = 5,
            MaxPoolSize = 40,
            CacheMaxAgeSeconds = 30,
            HealthCheckTimeoutSeconds = 3,
            ResultCacheEnabled = true,
            ResultCacheTtlSeconds = 20,
            ResultCacheMaxEntries = 8,
            ResultCacheMaxBytes = 1024 * 1024,
            MaxConcurrentQueries = 2,
            MaxQueuedQueries = 2,
            QueryDeadlineMilliseconds = 2_000,
            MaxResponseBytes = 1024 * 1024,
            MaxResponseFeatures = 200,
            MaxGeometryDepth = 32,
            MaxGeometryNodesPerFeature = 20_000,
            MaxGeometryNodesPerResponse = 100_000,
            TypeCatalogMaxTypes = 64,
            TypeCatalogSamplesPerType = 4,
            TypeCatalogCacheTtlSeconds = 60,
            TypeCatalogMaxTextLength = 240,
            TypeCatalogMaxResponseBytes = 256 * 1024,
            ObjectIdCursorEnabled = true
        };

        configure?.Invoke(options);
        return options;
    }

    public static KentRehberiSearchCriteria Search(
        string? ilce = "Çankaya",
        string? mahalle = "Kızılay",
        short? tur = 7,
        string? query = "park",
        KentRehberiBounds? bounds = null,
        int? afterObjectId = null,
        int limit = 50)
    {
        return new KentRehberiSearchCriteria(
            ilce,
            mahalle,
            tur,
            query,
            bounds,
            afterObjectId,
            limit);
    }

    public static KentRehberiNearbyCriteria Nearby(
        double longitude = 32.85,
        double latitude = 39.92,
        double radiusMeters = 2_000,
        string? ilce = "Çankaya",
        string? mahalle = null,
        short? tur = null,
        string? query = null,
        int limit = 50)
    {
        return new KentRehberiNearbyCriteria(
            longitude,
            latitude,
            radiusMeters,
            ilce,
            mahalle,
            tur,
            query,
            limit);
    }

    public static KentRehberiFeature Feature(
        int objectId = 1,
        double? x = 32.85,
        double? y = 39.92,
        double? distanceMeters = null,
        JsonNode? geometry = null,
        string? name = "Örnek Nokta")
    {
        geometry ??= JsonNode.Parse(
            """
            {
              "type": "Point",
              "coordinates": [32.85, 39.92]
            }
            """);

        return KentRehberiFeature.Create(
            objectId,
            geometry,
            new KentRehberiFeatureProperties(
                objectId,
                name,
                "Atatürk Bulvarı",
                "Çankaya",
                "Kızılay",
                x,
                y,
                7,
                1,
                "https://example.invalid",
                "101",
                distanceMeters));
    }

    public static KentRehberiTypeCatalog TypeCatalog(
        short firstType = 7,
        int typeCount = 2,
        int samplesPerType = 2)
    {
        var types = new List<KentRehberiTypeDescriptor>();

        for (var typeIndex = 0; typeIndex < typeCount; typeIndex++)
        {
            var type = (short)(firstType + typeIndex);
            var samples = new List<KentRehberiTypeSample>();

            for (var sampleIndex = 0; sampleIndex < samplesPerType; sampleIndex++)
            {
                var objectId =
                    1 + typeIndex * 100 + sampleIndex;

                samples.Add(
                    new KentRehberiTypeSample(
                        objectId,
                        $"Tür {type} Örnek {sampleIndex + 1}",
                        "Ankara",
                        sampleIndex % 2 == 0
                            ? objectId.ToString()
                            : null));
            }

            types.Add(
                new KentRehberiTypeDescriptor(
                    type,
                    samplesPerType + 10,
                    samples));
        }

        return KentRehberiTypeCatalog.Create(types);
    }

    public static KentRehberiFeatureCollection Collection(
        int count = 1,
        int limit = 50,
        int startId = 1,
        bool hasMore = false)
    {
        var features = new List<KentRehberiFeature>(
            Math.Max(0, count));

        for (var index = 0; index < count; index++)
        {
            features.Add(
                Feature(startId + index));
        }

        return KentRehberiFeatureCollection.Create(
            features,
            limit,
            hasMore,
            hasMore && features.Count > 0
                ? features[^1].Id
                : null);
    }
}

internal sealed class ManualKentRehberiTimeProvider :
    TimeProvider
{
    private DateTimeOffset utcNow;

    public ManualKentRehberiTimeProvider(
        DateTimeOffset utcNow)
    {
        this.utcNow = utcNow;
    }

    public override DateTimeOffset GetUtcNow() =>
        utcNow;

    public void Advance(TimeSpan duration)
    {
        utcNow = utcNow.Add(duration);
    }
}

internal sealed class FakeKentRehberiRepository :
    IKentRehberiRepository
{
    private readonly object sync = new();

    public bool IsConfigured { get; set; } = true;
    public int SearchCalls { get; private set; }
    public int NearbyCalls { get; private set; }
    public int ObjectCalls { get; private set; }
    public int TypeCatalogCalls { get; private set; }

    public Func<KentRehberiSearchCriteria,
        CancellationToken,
        Task<KentRehberiFeatureCollection>>?
        SearchHandler { get; set; }

    public Func<KentRehberiNearbyCriteria,
        CancellationToken,
        Task<KentRehberiFeatureCollection>>?
        NearbyHandler { get; set; }

    public Func<int,
        CancellationToken,
        Task<KentRehberiFeature?>>?
        ObjectHandler { get; set; }

    public Func<CancellationToken,
        Task<KentRehberiTypeCatalog>>?
        TypeCatalogHandler { get; set; }

    public Task<KentRehberiFeatureCollection> SearchAsync(
        KentRehberiSearchCriteria criteria,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            SearchCalls++;
        }

        return SearchHandler is null
            ? Task.FromResult(
                KentRehberiRuntimeTestData.Collection(
                    limit: criteria.Limit))
            : SearchHandler(
                criteria,
                cancellationToken);
    }

    public Task<KentRehberiFeature?> GetByObjectIdAsync(
        int objectId,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            ObjectCalls++;
        }

        return ObjectHandler is null
            ? Task.FromResult<KentRehberiFeature?>(
                KentRehberiRuntimeTestData.Feature(
                    objectId))
            : ObjectHandler(
                objectId,
                cancellationToken);
    }

    public Task<KentRehberiFeatureCollection> FindNearbyAsync(
        KentRehberiNearbyCriteria criteria,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            NearbyCalls++;
        }

        return NearbyHandler is null
            ? Task.FromResult(
                KentRehberiRuntimeTestData.Collection(
                    limit: criteria.Limit))
            : NearbyHandler(
                criteria,
                cancellationToken);
    }

    public Task<KentRehberiTypeCatalog> GetTypeCatalogAsync(
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            TypeCatalogCalls++;
        }

        return TypeCatalogHandler is null
            ? Task.FromResult(
                KentRehberiRuntimeTestData.TypeCatalog())
            : TypeCatalogHandler(cancellationToken);
    }
}
