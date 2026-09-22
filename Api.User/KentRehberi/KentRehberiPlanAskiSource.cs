using Microsoft.Extensions.Logging;
using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public sealed record KentRehberiPlanAskiSourceSnapshot(
    int CachedTypes,
    int InFlightTypes,
    long CacheHits,
    long CacheMisses,
    long FetchStarted,
    long FetchCompleted,
    long FetchFailed,
    long RecordsAccepted,
    DateTimeOffset? OldestExpiry,
    DateTimeOffset? NewestExpiry);

public sealed class KentRehberiPlanAskiProtocolException :
    InvalidOperationException
{
    public KentRehberiPlanAskiProtocolException(string message)
        : base(message)
    {
    }
}

public sealed class KentRehberiPlanAskiUnavailableException :
    InvalidOperationException
{
    public KentRehberiPlanAskiUnavailableException(string message)
        : base(message)
    {
    }
}

public sealed class KentRehberiPlanAskiSource : IDisposable
{
    public const string HttpClientName =
        "KentRehberi.PlanAski";

    private static readonly string[] EnvelopeArrayNames =
    {
        "data",
        "results",
        "items",
        "records",
        "features",
        "result"
    };

    private static readonly string[] ObjectIdNames =
    {
        "objectid",
        "object_id",
        "objectId",
        "OBJECTID",
        "id",
        "Id"
    };

    private static readonly string[] NameNames =
    {
        "adi",
        "adı",
        "ad",
        "name",
        "isim",
        "tesis_adi",
        "tesisAdi"
    };

    private static readonly string[] AddressNames =
    {
        "adres",
        "address",
        "acik_adres",
        "acikAdres",
        "adres_tarifi"
    };

    private static readonly string[] DistrictNames =
    {
        "ilce",
        "ilçe",
        "district"
    };

    private static readonly string[] NeighborhoodNames =
    {
        "mahalle",
        "neighborhood"
    };

    private static readonly string[] LongitudeNames =
    {
        "x",
        "X",
        "longitude",
        "lon",
        "lng"
    };

    private static readonly string[] LatitudeNames =
    {
        "y",
        "Y",
        "latitude",
        "lat"
    };

    private static readonly string[] TypeNames =
    {
        "tur",
        "tür",
        "typeId",
        "type_id"
    };

    private static readonly string[] OwnerNames =
    {
        "yapan",
        "owner",
        "ownerId",
        "owner_id"
    };

    private static readonly string[] WebPageNames =
    {
        "web_sayfasi",
        "webSayfasi",
        "websayfasi",
        "web",
        "website",
        "url"
    };

    private static readonly string[] StopNumberNames =
    {
        "durak_no",
        "durakNo",
        "durakno",
        "stop_no",
        "stopNo"
    };

    private readonly IHttpClientFactory httpClientFactory;
    private readonly KentRehberiOptions options;
    private readonly TimeProvider timeProvider;
    private readonly ILogger<KentRehberiPlanAskiSource> logger;
    private readonly SemaphoreSlim concurrency;
    private readonly ConcurrentDictionary<short, CacheEntry> cache = new();
    private readonly ConcurrentDictionary<
        short,
        Task<IReadOnlyList<KentRehberiFeature>>>
        inFlight = new();

    private long cacheHits;
    private long cacheMisses;
    private long fetchStarted;
    private long fetchCompleted;
    private long fetchFailed;
    private long recordsAccepted;
    private int disposed;

    public KentRehberiPlanAskiSource(
        IHttpClientFactory httpClientFactory,
        KentRehberiOptions options,
        TimeProvider timeProvider,
        ILogger<KentRehberiPlanAskiSource> logger)
    {
        ArgumentNullException.ThrowIfNull(httpClientFactory);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(timeProvider);
        ArgumentNullException.ThrowIfNull(logger);

        this.httpClientFactory = httpClientFactory;
        this.options = options;
        this.timeProvider = timeProvider;
        this.logger = logger;
        concurrency = new SemaphoreSlim(
            options.PlanAskiMaxConcurrentRequests,
            options.PlanAskiMaxConcurrentRequests);
    }

    public bool IsConfigured =>
        options.Enabled &&
        string.Equals(
            options.Source,
            KentRehberiOptions.PlanAskiSource,
            StringComparison.OrdinalIgnoreCase) &&
        TryGetOfficialBaseUri(out _);

    public IEnumerable<short> Types
    {
        get
        {
            for (var type = options.PlanAskiMinTur;
                 type <= options.PlanAskiMaxTur;
                 type++)
            {
                yield return type;
            }
        }
    }

    public async Task<IReadOnlyList<KentRehberiFeature>>
        GetTypeAsync(
            short tur,
            CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        ValidateType(tur);

        if (TryReadCache(
                tur,
                out var cached))
        {
            Interlocked.Increment(
                ref cacheHits);
            return cached;
        }

        Interlocked.Increment(
            ref cacheMisses);

        while (true)
        {
            var task = inFlight.GetOrAdd(
                tur,
                CreateFetchTask);

            try
            {
                return await task.WaitAsync(
                        cancellationToken)
                    .ConfigureAwait(false);
            }
            finally
            {
                if (task.IsCompleted)
                {
                    inFlight.TryRemove(
                        tur,
                        out _);
                }
            }
        }
    }

    public async Task<
        IReadOnlyDictionary<
            short,
            IReadOnlyList<KentRehberiFeature>>>
        GetAllTypesAsync(
            CancellationToken cancellationToken)
    {
        ThrowIfDisposed();

        var tasks = Types
            .Select(
                async tur =>
                    new KeyValuePair<
                        short,
                        IReadOnlyList<KentRehberiFeature>>(
                        tur,
                        await GetTypeAsync(
                                tur,
                                cancellationToken)
                            .ConfigureAwait(false)))
            .ToArray();

        var values =
            await Task.WhenAll(tasks)
                .ConfigureAwait(false);

        return values.ToDictionary(
            pair => pair.Key,
            pair => pair.Value);
    }

    public async Task ProbeAsync(
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        ValidateConfigured();

        using var timeout =
            CancellationTokenSource
                .CreateLinkedTokenSource(
                    cancellationToken);
        timeout.CancelAfter(
            TimeSpan.FromSeconds(
                options.HealthCheckTimeoutSeconds));

        var tur =
            options.PlanAskiMinTur;

        await FetchTypeCoreAsync(
                tur,
                requestTimeout.Token,
                cacheResult: false)
            .ConfigureAwait(false);
    }

    public void Clear()
    {
        cache.Clear();
    }

    public KentRehberiPlanAskiSourceSnapshot
        GetSnapshot()
    {
        var now =
            timeProvider.GetUtcNow();

        var liveEntries =
            cache.Values
                .Where(entry =>
                    entry.ExpiresAt > now)
                .ToArray();

        return new KentRehberiPlanAskiSourceSnapshot(
            liveEntries.Length,
            inFlight.Count,
            Volatile.Read(ref cacheHits),
            Volatile.Read(ref cacheMisses),
            Volatile.Read(ref fetchStarted),
            Volatile.Read(ref fetchCompleted),
            Volatile.Read(ref fetchFailed),
            Volatile.Read(ref recordsAccepted),
            liveEntries.Length == 0
                ? null
                : liveEntries.Min(
                    entry => entry.ExpiresAt),
            liveEntries.Length == 0
                ? null
                : liveEntries.Max(
                    entry => entry.ExpiresAt));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(
                ref disposed,
                1) != 0)
        {
            return;
        }

        concurrency.Dispose();
        cache.Clear();
        inFlight.Clear();
    }

    private Task<IReadOnlyList<KentRehberiFeature>>
        CreateFetchTask(short tur) =>
        FetchTypeCoreAsync(
            tur,
            CancellationToken.None,
            cacheResult: true);

    private async Task<
        IReadOnlyList<KentRehberiFeature>>
        FetchTypeCoreAsync(
            short tur,
            CancellationToken cancellationToken,
            bool cacheResult)
    {
        ValidateConfigured();

        using var admissionTimeout =
            CancellationTokenSource
                .CreateLinkedTokenSource(
                    cancellationToken);
        admissionTimeout.CancelAfter(
            TimeSpan.FromMilliseconds(
                options.QueryDeadlineMilliseconds));

        try
        {
            await concurrency.WaitAsync(
                    admissionTimeout.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            throw new KentRehberiPlanAskiUnavailableException(
                "The official Kent Rehberi upstream request could not enter the bounded concurrency window before the query deadline.");
        }

        Interlocked.Increment(
            ref fetchStarted);

        try
        {
            using var requestTimeout =
                CancellationTokenSource
                    .CreateLinkedTokenSource(
                        cancellationToken);
            requestTimeout.CancelAfter(
                TimeSpan.FromSeconds(
                    options.PlanAskiRequestTimeoutSeconds));

            var client =
                httpClientFactory.CreateClient(
                    HttpClientName);
            var requestUri =
                BuildRequestUri(tur);

            using var request =
                new HttpRequestMessage(
                    HttpMethod.Get,
                    requestUri);
            request.Headers.Accept.Clear();
            request.Headers.Accept.Add(
                new MediaTypeWithQualityHeaderValue(
                    "application/json"));
            request.Headers.Accept.Add(
                new MediaTypeWithQualityHeaderValue(
                    "application/geo+json",
                    0.9));

            using var response =
                await client.SendAsync(
                        request,
                        HttpCompletionOption.ResponseHeadersRead,
                        requestTimeout.Token)
                    .ConfigureAwait(false);

            if (IsRedirect(response.StatusCode))
            {
                throw new KentRehberiPlanAskiUnavailableException(
                    "The official Kent Rehberi upstream returned an unexpected redirect.");
            }

            if (!response.IsSuccessStatusCode)
            {
                throw new KentRehberiPlanAskiUnavailableException(
                    $"The official Kent Rehberi upstream returned HTTP {(int)response.StatusCode}.");
            }

            ValidateContentType(
                response.Content.Headers.ContentType);

            var payload =
                await ReadBoundedPayloadAsync(
                        response.Content,
                        requestTimeout.Token)
                    .ConfigureAwait(false);

            var features =
                ParsePayload(
                    payload,
                    tur);

            if (cacheResult)
            {
                cache[tur] =
                    new CacheEntry(
                        features,
                        timeProvider
                            .GetUtcNow()
                            .AddSeconds(
                                options.PlanAskiCacheTtlSeconds));
            }

            Interlocked.Increment(
                ref fetchCompleted);
            Interlocked.Add(
                ref recordsAccepted,
                features.Count);

            return features;
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            Interlocked.Increment(
                ref fetchFailed);

            throw new KentRehberiPlanAskiUnavailableException(
                "The official Kent Rehberi upstream request timed out.");
        }
        catch
        {
            Interlocked.Increment(
                ref fetchFailed);
            throw;
        }
        finally
        {
            concurrency.Release();
        }
    }

    private bool TryReadCache(
        short tur,
        out IReadOnlyList<KentRehberiFeature>
            features)
    {
        if (!cache.TryGetValue(
                tur,
                out var entry))
        {
            features = null!;
            return false;
        }

        if (entry.ExpiresAt <=
            timeProvider.GetUtcNow())
        {
            cache.TryRemove(
                tur,
                out _);
            features = null!;
            return false;
        }

        features = entry.Features;
        return true;
    }

    private Uri BuildRequestUri(short tur)
    {
        if (!TryGetOfficialBaseUri(
                out var baseUri))
        {
            throw new KentRehberiPlanAskiUnavailableException(
                "The official Kent Rehberi upstream endpoint is not configured.");
        }

        var builder =
            new UriBuilder(baseUri)
            {
                Query =
                    "tur=" +
                    tur.ToString(
                        CultureInfo.InvariantCulture)
            };

        return builder.Uri;
    }

    private bool TryGetOfficialBaseUri(
        out Uri baseUri)
    {
        if (!Uri.TryCreate(
                options.PlanAskiBaseUri,
                UriKind.Absolute,
                out var candidate))
        {
            baseUri = null!;
            return false;
        }

        if (!string.Equals(
                candidate.Scheme,
                Uri.UriSchemeHttps,
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(
                candidate.Host,
                "planaski.ankara.bel.tr",
                StringComparison.OrdinalIgnoreCase) ||
            candidate.Port != 443 ||
            !string.Equals(
                candidate.AbsolutePath
                    .TrimEnd('/'),
                "/kentrehberiapi/api/kentrehberi",
                StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(
                candidate.UserInfo) ||
            !string.IsNullOrEmpty(
                candidate.Query) ||
            !string.IsNullOrEmpty(
                candidate.Fragment))
        {
            baseUri = null!;
            return false;
        }

        baseUri = candidate;
        return true;
    }

    private async Task<byte[]>
        ReadBoundedPayloadAsync(
            HttpContent content,
            CancellationToken cancellationToken)
    {
        var declaredLength =
            content.Headers.ContentLength;

        if (declaredLength.HasValue &&
            declaredLength.Value >
            options.PlanAskiMaxResponseBytesPerType)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream response exceeded the configured byte budget.");
        }

        await using var stream =
            await content.ReadAsStreamAsync(
                    cancellationToken)
                .ConfigureAwait(false);
        await using var destination =
            new MemoryStream(
                declaredLength is > 0 and <= int.MaxValue
                    ? (int)declaredLength.Value
                    : 0);

        var rented =
            ArrayPool<byte>.Shared.Rent(
                32 * 1024);

        try
        {
            long total = 0;

            while (true)
            {
                var read =
                    await stream.ReadAsync(
                            rented.AsMemory(
                                0,
                                rented.Length),
                            cancellationToken)
                        .ConfigureAwait(false);

                if (read == 0)
                {
                    break;
                }

                total = checked(
                    total + read);

                if (total >
                    options
                        .PlanAskiMaxResponseBytesPerType)
                {
                    throw new KentRehberiPlanAskiProtocolException(
                        "The official Kent Rehberi upstream response exceeded the configured byte budget.");
                }

                await destination.WriteAsync(
                        rented.AsMemory(
                            0,
                            read),
                        cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(
                rented,
                clearArray: true);
        }

        return destination.ToArray();
    }

    private IReadOnlyList<KentRehberiFeature>
        ParsePayload(
            byte[] payload,
            short requestedTur)
    {
        try
        {
            using var document =
                JsonDocument.Parse(
                    payload,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling =
                            JsonCommentHandling.Disallow,
                        MaxDepth = 64
                    });

            EnsureSuccessfulEnvelope(
                document.RootElement);

            if (IsExplicitEmptyEnvelope(
                    document.RootElement))
            {
                return Array.Empty<
                    KentRehberiFeature>();
            }

            var records =
                ExtractRecordArray(
                    document.RootElement);

            if (records.GetArrayLength() >
                options.PlanAskiMaxRecordsPerType)
            {
                throw new KentRehberiPlanAskiProtocolException(
                    "The official Kent Rehberi upstream response exceeded the configured record budget.");
            }

            var features =
                new List<KentRehberiFeature>(
                    records.GetArrayLength());
            var objectIds =
                new HashSet<int>();

            foreach (var record in
                     records.EnumerateArray())
            {
                var feature =
                    ParseFeature(
                        record,
                        requestedTur);

                if (!objectIds.Add(
                        feature.Id))
                {
                    throw new KentRehberiPlanAskiProtocolException(
                        "The official Kent Rehberi upstream returned duplicate object identifiers for one type.");
                }

                features.Add(feature);
            }

            features.Sort(
                static (left, right) =>
                    left.Id.CompareTo(
                        right.Id));

            return features.AsReadOnly();
        }
        catch (JsonException exception)
        {
            logger.LogWarning(
                exception,
                "PlanASKI Kent Rehberi returned malformed JSON for tur {Tur}.",
                requestedTur);

            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream returned malformed JSON.");
        }
    }

    private static void EnsureSuccessfulEnvelope(
        JsonElement root)
    {
        if (root.ValueKind !=
            JsonValueKind.Object)
        {
            return;
        }

        foreach (var name in
                 new[]
                 {
                     "isSuccess",
                     "success",
                     "successful"
                 })
        {
            if (!TryGetProperty(
                    root,
                    name,
                    out var value))
            {
                continue;
            }

            if (value.ValueKind ==
                    JsonValueKind.False)
            {
                throw new KentRehberiPlanAskiProtocolException(
                    "The official Kent Rehberi upstream reported an unsuccessful response.");
            }

            if (value.ValueKind is
                not JsonValueKind.True and
                not JsonValueKind.Null and
                not JsonValueKind.Undefined)
            {
                throw new KentRehberiPlanAskiProtocolException(
                    "The official Kent Rehberi upstream returned an invalid success flag.");
            }

            return;
        }
    }

    private static bool IsExplicitEmptyEnvelope(
        JsonElement root)
    {
        if (root.ValueKind !=
            JsonValueKind.Object)
        {
            return false;
        }

        var foundEnvelope =
            false;

        foreach (var name in
                 EnvelopeArrayNames)
        {
            if (!TryGetProperty(
                    root,
                    name,
                    out var value))
            {
                continue;
            }

            foundEnvelope = true;

            if (value.ValueKind is
                JsonValueKind.Array or
                JsonValueKind.Object)
            {
                return false;
            }

            if (value.ValueKind is
                not JsonValueKind.Null and
                not JsonValueKind.Undefined)
            {
                return false;
            }
        }

        return foundEnvelope;
    }

    private static JsonElement ExtractRecordArray(
        JsonElement root)
    {
        if (root.ValueKind ==
            JsonValueKind.Array)
        {
            return root;
        }

        if (root.ValueKind !=
            JsonValueKind.Object)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream response root must be an object or array.");
        }

        if (TryGetProperty(
                root,
                "features",
                out var features) &&
            features.ValueKind ==
                JsonValueKind.Array)
        {
            return features;
        }

        foreach (var name in
                 EnvelopeArrayNames)
        {
            if (!TryGetProperty(
                    root,
                    name,
                    out var candidate))
            {
                continue;
            }

            if (candidate.ValueKind ==
                JsonValueKind.Array)
            {
                return candidate;
            }

            if (candidate.ValueKind ==
                JsonValueKind.Object)
            {
                foreach (var nestedName in
                         EnvelopeArrayNames)
                {
                    if (TryGetProperty(
                            candidate,
                            nestedName,
                            out var nested) &&
                        nested.ValueKind ==
                            JsonValueKind.Array)
                    {
                        return nested;
                    }
                }
            }
        }

        throw new KentRehberiPlanAskiProtocolException(
            "The official Kent Rehberi upstream response does not contain a supported record array.");
    }

    private KentRehberiFeature ParseFeature(
        JsonElement record,
        short requestedTur)
    {
        if (record.ValueKind !=
            JsonValueKind.Object)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream contains a non-object record.");
        }

        var properties =
            GetPropertiesObject(record);

        var objectId =
            ReadRequiredPositiveInt(
                properties,
                ObjectIdNames,
                "objectid");

        var returnedTur =
            ReadNullableShort(
                properties,
                TypeNames);

        if (returnedTur.HasValue &&
            returnedTur.Value !=
                requestedTur)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream returned a record for a different type.");
        }

        var longitude =
            ReadNullableDouble(
                properties,
                LongitudeNames);
        var latitude =
            ReadNullableDouble(
                properties,
                LatitudeNames);

        var geometry =
            ReadGeometry(
                record,
                ref longitude,
                ref latitude);

        ValidateCoordinatePair(
            longitude,
            latitude);

        if (geometry is null &&
            longitude.HasValue &&
            latitude.HasValue)
        {
            geometry =
                new JsonObject
                {
                    ["type"] = "Point",
                    ["coordinates"] =
                        new JsonArray(
                            longitude.Value,
                            latitude.Value)
                };
        }

        return KentRehberiFeature.Create(
            objectId,
            geometry,
            new KentRehberiFeatureProperties(
                objectId,
                ReadNullableString(
                    properties,
                    NameNames),
                ReadNullableString(
                    properties,
                    AddressNames),
                ReadNullableString(
                    properties,
                    DistrictNames),
                ReadNullableString(
                    properties,
                    NeighborhoodNames),
                longitude,
                latitude,
                requestedTur,
                ReadNullableShort(
                    properties,
                    OwnerNames),
                ReadNullableString(
                    properties,
                    WebPageNames),
                ReadNullableString(
                    properties,
                    StopNumberNames),
                DistanceMeters: null));
    }

    private static JsonElement GetPropertiesObject(
        JsonElement record)
    {
        if (TryGetProperty(
                record,
                "properties",
                out var properties) &&
            properties.ValueKind ==
                JsonValueKind.Object)
        {
            return properties;
        }

        return record;
    }

    private static JsonNode? ReadGeometry(
        JsonElement record,
        ref double? longitude,
        ref double? latitude)
    {
        if (!TryGetProperty(
                record,
                "geometry",
                out var geometry) ||
            geometry.ValueKind ==
                JsonValueKind.Null ||
            geometry.ValueKind ==
                JsonValueKind.Undefined)
        {
            return null;
        }

        if (geometry.ValueKind !=
            JsonValueKind.Object)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream contains invalid geometry.");
        }

        if (TryGetProperty(
                geometry,
                "coordinates",
                out var coordinates) &&
            coordinates.ValueKind ==
                JsonValueKind.Array)
        {
            if (coordinates.GetArrayLength() < 2)
            {
                throw new KentRehberiPlanAskiProtocolException(
                    "The official Kent Rehberi upstream point geometry is incomplete.");
            }

            var enumerator =
                coordinates.EnumerateArray();
            enumerator.MoveNext();
            var geometryLongitude =
                ReadDoubleValue(
                    enumerator.Current,
                    "geometry longitude");
            enumerator.MoveNext();
            var geometryLatitude =
                ReadDoubleValue(
                    enumerator.Current,
                    "geometry latitude");

            longitude ??=
                geometryLongitude;
            latitude ??=
                geometryLatitude;

            return new JsonObject
            {
                ["type"] = "Point",
                ["coordinates"] =
                    new JsonArray(
                        geometryLongitude,
                        geometryLatitude)
            };
        }

        var fallbackLongitude =
            ReadNullableDouble(
                geometry,
                LongitudeNames);
        var fallbackLatitude =
            ReadNullableDouble(
                geometry,
                LatitudeNames);

        if (fallbackLongitude.HasValue &&
            fallbackLatitude.HasValue)
        {
            longitude ??=
                fallbackLongitude.Value;
            latitude ??=
                fallbackLatitude.Value;

            return new JsonObject
            {
                ["type"] = "Point",
                ["coordinates"] =
                    new JsonArray(
                        fallbackLongitude.Value,
                        fallbackLatitude.Value)
            };
        }

        throw new KentRehberiPlanAskiProtocolException(
            "The official Kent Rehberi upstream geometry format is unsupported.");
    }

    private static void ValidateCoordinatePair(
        double? longitude,
        double? latitude)
    {
        if (longitude.HasValue !=
            latitude.HasValue)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream returned an incomplete coordinate pair.");
        }

        if (!longitude.HasValue)
        {
            return;
        }

        if (!double.IsFinite(
                longitude.Value) ||
            longitude.Value is < -180 or > 180 ||
            !double.IsFinite(
                latitude!.Value) ||
            latitude.Value is < -90 or > 90)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream returned coordinates outside EPSG:4326 bounds.");
        }
    }

    private static int ReadRequiredPositiveInt(
        JsonElement source,
        IEnumerable<string> names,
        string field)
    {
        if (!TryGetProperty(
                source,
                names,
                out var element))
        {
            throw new KentRehberiPlanAskiProtocolException(
                $"The official Kent Rehberi upstream record is missing {field}.");
        }

        var value =
            ReadIntValue(
                element,
                field);

        if (value <= 0)
        {
            throw new KentRehberiPlanAskiProtocolException(
                $"The official Kent Rehberi upstream record contains an invalid {field}.");
        }

        return value;
    }

    private static int ReadIntValue(
        JsonElement element,
        string field)
    {
        if (element.ValueKind ==
                JsonValueKind.Number &&
            element.TryGetInt32(
                out var numeric))
        {
            return numeric;
        }

        if (element.ValueKind ==
                JsonValueKind.String &&
            int.TryParse(
                element.GetString(),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out numeric))
        {
            return numeric;
        }

        throw new KentRehberiPlanAskiProtocolException(
            $"The official Kent Rehberi upstream record contains a non-integer {field}.");
    }

    private static short? ReadNullableShort(
        JsonElement source,
        IEnumerable<string> names)
    {
        if (!TryGetProperty(
                source,
                names,
                out var element) ||
            element.ValueKind is
                JsonValueKind.Null or
                JsonValueKind.Undefined)
        {
            return null;
        }

        if (element.ValueKind ==
                JsonValueKind.Number &&
            element.TryGetInt16(
                out var numeric))
        {
            return numeric;
        }

        if (element.ValueKind ==
                JsonValueKind.String &&
            short.TryParse(
                element.GetString(),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out numeric))
        {
            return numeric;
        }

        throw new KentRehberiPlanAskiProtocolException(
            "The official Kent Rehberi upstream record contains a non-integer small-number field.");
    }

    private static double? ReadNullableDouble(
        JsonElement source,
        IEnumerable<string> names)
    {
        if (!TryGetProperty(
                source,
                names,
                out var element) ||
            element.ValueKind is
                JsonValueKind.Null or
                JsonValueKind.Undefined)
        {
            return null;
        }

        return ReadDoubleValue(
            element,
            "coordinate");
    }

    private static double ReadDoubleValue(
        JsonElement element,
        string field)
    {
        if (element.ValueKind ==
                JsonValueKind.Number &&
            element.TryGetDouble(
                out var numeric) &&
            double.IsFinite(numeric))
        {
            return numeric;
        }

        if (element.ValueKind ==
                JsonValueKind.String)
        {
            var text =
                element.GetString()
                    ?.Trim();

            if (!string.IsNullOrEmpty(
                    text) &&
                double.TryParse(
                    text.Replace(
                        ',',
                        '.'),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out numeric) &&
                double.IsFinite(
                    numeric))
            {
                return numeric;
            }
        }

        throw new KentRehberiPlanAskiProtocolException(
            $"The official Kent Rehberi upstream record contains an invalid {field}.");
    }

    private static string? ReadNullableString(
        JsonElement source,
        IEnumerable<string> names)
    {
        if (!TryGetProperty(
                source,
                names,
                out var element) ||
            element.ValueKind is
                JsonValueKind.Null or
                JsonValueKind.Undefined)
        {
            return null;
        }

        string? value =
            element.ValueKind switch
            {
                JsonValueKind.String =>
                    element.GetString(),
                JsonValueKind.Number =>
                    element.GetRawText(),
                JsonValueKind.True =>
                    "true",
                JsonValueKind.False =>
                    "false",
                _ =>
                    throw new KentRehberiPlanAskiProtocolException(
                        "The official Kent Rehberi upstream record contains a non-scalar text field.")
            };

        var normalized =
            value?.Trim();

        if (string.IsNullOrEmpty(
                normalized))
        {
            return null;
        }

        if (normalized.Length >
            4_096)
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream record contains an oversized text field.");
        }

        if (normalized.Any(
                char.IsControl))
        {
            throw new KentRehberiPlanAskiProtocolException(
                "The official Kent Rehberi upstream record contains control characters.");
        }

        return normalized;
    }

    private static bool TryGetProperty(
        JsonElement source,
        IEnumerable<string> names,
        out JsonElement value)
    {
        foreach (var name in names)
        {
            if (TryGetProperty(
                    source,
                    name,
                    out value))
            {
                return true;
            }
        }

        value = default;
        return false;
    }

    private static bool TryGetProperty(
        JsonElement source,
        string name,
        out JsonElement value)
    {
        if (source.ValueKind !=
            JsonValueKind.Object)
        {
            value = default;
            return false;
        }

        if (source.TryGetProperty(
                name,
                out value))
        {
            return true;
        }

        foreach (var property in
                 source.EnumerateObject())
        {
            if (string.Equals(
                    property.Name,
                    name,
                    StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }

        value = default;
        return false;
    }

    private static void ValidateContentType(
        MediaTypeHeaderValue? contentType)
    {
        if (contentType is null)
        {
            return;
        }

        var mediaType =
            contentType.MediaType;

        if (string.Equals(
                mediaType,
                "application/json",
                StringComparison.OrdinalIgnoreCase) ||
            string.Equals(
                mediaType,
                "application/geo+json",
                StringComparison.OrdinalIgnoreCase) ||
            string.Equals(
                mediaType,
                "text/json",
                StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        throw new KentRehberiPlanAskiProtocolException(
            "The official Kent Rehberi upstream returned an unexpected content type.");
    }

    private static bool IsRedirect(
        HttpStatusCode statusCode)
    {
        var numeric =
            (int)statusCode;

        return numeric is >= 300 and < 400;
    }

    private void ValidateType(short tur)
    {
        if (tur <
                options.PlanAskiMinTur ||
            tur >
                options.PlanAskiMaxTur)
        {
            throw new ArgumentOutOfRangeException(
                nameof(tur),
                $"tur must be between {options.PlanAskiMinTur} and {options.PlanAskiMaxTur}.");
        }
    }

    private void ValidateConfigured()
    {
        if (!IsConfigured)
        {
            throw new KentRehberiPlanAskiUnavailableException(
                "The official Kent Rehberi upstream source is not configured.");
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref disposed) != 0,
            this);
    }

    private sealed record CacheEntry(
        IReadOnlyList<KentRehberiFeature> Features,
        DateTimeOffset ExpiresAt);
}
