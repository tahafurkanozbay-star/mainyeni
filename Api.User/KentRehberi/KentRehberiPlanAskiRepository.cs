using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public sealed class KentRehberiPlanAskiRepository :
    IKentRehberiRepository
{
    private readonly KentRehberiPlanAskiSource source;
    private readonly KentRehberiOptions options;

    public KentRehberiPlanAskiRepository(
        KentRehberiPlanAskiSource source,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(options);

        this.source = source;
        this.options = options;
    }

    public bool IsConfigured =>
        source.IsConfigured;

    public async Task<KentRehberiFeatureCollection>
        SearchAsync(
            KentRehberiSearchCriteria criteria,
            CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        var features =
            await LoadCandidateFeaturesAsync(
                    criteria.Tur,
                    cancellationToken)
                .ConfigureAwait(false);

        var filtered =
            features
                .Where(
                    feature =>
                        MatchesCommonFilters(
                            feature,
                            criteria.Ilce,
                            criteria.Mahalle,
                            criteria.Query) &&
                        MatchesBounds(
                            feature,
                            criteria.Bounds))
                .Where(
                    feature =>
                        !criteria.AfterObjectId.HasValue ||
                        feature.Id >
                            criteria.AfterObjectId.Value)
                .OrderBy(
                    feature =>
                        feature.Id)
                .Take(
                    criteria.Limit + 1)
                .ToList();

        return ToPagedCollection(
            filtered,
            criteria.Limit);
    }

    public async Task<KentRehberiFeature?>
        GetByObjectIdAsync(
            int objectId,
            CancellationToken cancellationToken)
    {
        if (objectId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(objectId),
                "objectId must be greater than zero.");
        }

        var all =
            await source.GetAllTypesAsync(
                    cancellationToken)
                .ConfigureAwait(false);

        KentRehberiFeature? found =
            null;

        foreach (var pair in
                 all.OrderBy(
                     pair => pair.Key))
        {
            foreach (var feature in
                     pair.Value)
            {
                if (feature.Id !=
                    objectId)
                {
                    continue;
                }

                if (found is not null)
                {
                    throw new KentRehberiDataIntegrityException(
                        "The official Kent Rehberi upstream contains a duplicate objectid across types.");
                }

                found = feature;
            }
        }

        return found;
    }

    public async Task<KentRehberiFeatureCollection>
        FindNearbyAsync(
            KentRehberiNearbyCriteria criteria,
            CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        var features =
            await LoadCandidateFeaturesAsync(
                    criteria.Tur,
                    cancellationToken)
                .ConfigureAwait(false);

        var nearby =
            features
                .Where(
                    feature =>
                        MatchesCommonFilters(
                            feature,
                            criteria.Ilce,
                            criteria.Mahalle,
                            criteria.Query))
                .Select(
                    feature =>
                        WithDistance(
                            feature,
                            criteria.Longitude,
                            criteria.Latitude))
                .Where(
                    feature =>
                        feature is not null &&
                        feature.Properties.DistanceMeters <=
                            criteria.RadiusMeters)
                .Select(
                    feature =>
                        feature!)
                .OrderBy(
                    feature =>
                        feature.Properties.DistanceMeters)
                .ThenBy(
                    feature =>
                        feature.Id)
                .Take(
                    criteria.Limit + 1)
                .ToList();

        return ToPagedCollection(
            nearby,
            criteria.Limit,
            includeCursor: false);
    }

    public async Task<KentRehberiTypeCatalog>
        GetTypeCatalogAsync(
            CancellationToken cancellationToken)
    {
        var all =
            await source.GetAllTypesAsync(
                    cancellationToken)
                .ConfigureAwait(false);

        var descriptors =
            new List<KentRehberiTypeDescriptor>(
                all.Count);

        foreach (var tur in
                 source.Types)
        {
            all.TryGetValue(
                tur,
                out var features);

            features ??=
                Array.Empty<KentRehberiFeature>();

            descriptors.Add(
                new KentRehberiTypeDescriptor(
                    tur,
                    features.Count,
                    BuildSamples(
                        features,
                        options
                            .TypeCatalogSamplesPerType)));
        }

        return KentRehberiTypeCatalog.Create(
            descriptors);
    }

    private async Task<
        IReadOnlyList<KentRehberiFeature>>
        LoadCandidateFeaturesAsync(
            short? tur,
            CancellationToken cancellationToken)
    {
        if (tur.HasValue)
        {
            if (!IsUpstreamType(
                    tur.Value))
            {
                return Array.Empty<KentRehberiFeature>();
            }

            return await source.GetTypeAsync(
                    tur.Value,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        var all =
            await source.GetAllTypesAsync(
                    cancellationToken)
                .ConfigureAwait(false);

        var capacity =
            all.Sum(
                pair =>
                    pair.Value.Count);
        var combined =
            new List<KentRehberiFeature>(
                capacity);
        var objectIds =
            new HashSet<int>();

        foreach (var pair in
                 all.OrderBy(
                     pair =>
                         pair.Key))
        {
            foreach (var feature in
                     pair.Value)
            {
                if (!objectIds.Add(
                        feature.Id))
                {
                    throw new KentRehberiDataIntegrityException(
                        "The official Kent Rehberi upstream contains a duplicate objectid across types.");
                }

                combined.Add(
                    feature);
            }
        }

        return combined;
    }

    private bool IsUpstreamType(
        short tur) =>
        tur >=
            options.PlanAskiMinTur &&
        tur <=
            options.PlanAskiMaxTur;

    private KentRehberiFeatureCollection
        ToPagedCollection(
            List<KentRehberiFeature> features,
            int limit,
            bool includeCursor = true)
    {
        var hasMore =
            features.Count >
            limit;

        if (hasMore)
        {
            features.RemoveAt(
                features.Count - 1);
        }

        var nextAfterObjectId =
            includeCursor &&
            hasMore &&
            options.ObjectIdCursorEnabled &&
            features.Count > 0
                ? features[^1].Id
                : (int?)null;

        return KentRehberiFeatureCollection.Create(
            features,
            limit,
            hasMore,
            nextAfterObjectId);
    }

    private static bool MatchesCommonFilters(
        KentRehberiFeature feature,
        string? ilce,
        string? mahalle,
        string? query)
    {
        var properties =
            feature.Properties;

        if (!Contains(
                properties.Ilce,
                ilce))
        {
            return false;
        }

        if (!Contains(
                properties.Mahalle,
                mahalle))
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(
                query))
        {
            return true;
        }

        return Contains(
                properties.Adi,
                query) ||
            Contains(
                properties.Adres,
                query) ||
            Contains(
                properties.Ilce,
                query) ||
            Contains(
                properties.Mahalle,
                query) ||
            Contains(
                properties.WebSayfasi,
                query) ||
            Contains(
                properties.DurakNo,
                query);
    }

    private static bool Contains(
        string? value,
        string? expected)
    {
        if (string.IsNullOrWhiteSpace(
                expected))
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(
                value))
        {
            return false;
        }

        var foldedValue =
            FoldSearchText(value);
        var foldedExpected =
            FoldSearchText(expected);

        return foldedValue.Contains(
            foldedExpected,
            StringComparison.Ordinal);
    }

    private static string FoldSearchText(
        string value)
    {
        var normalized =
            value
                .Trim()
                .ToLowerInvariant()
                .Normalize(
                    NormalizationForm.FormD);

        var builder =
            new StringBuilder(
                normalized.Length);

        foreach (var character in
                 normalized)
        {
            if (CharUnicodeInfo
                    .GetUnicodeCategory(
                        character) ==
                UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            builder.Append(
                character == 'ı'
                    ? 'i'
                    : character);
        }

        return builder
            .ToString()
            .Normalize(
                NormalizationForm.FormC);
    }

    private static bool MatchesBounds(
        KentRehberiFeature feature,
        KentRehberiBounds? bounds)
    {
        if (bounds is null)
        {
            return true;
        }

        var longitude =
            feature.Properties.X;
        var latitude =
            feature.Properties.Y;

        return longitude.HasValue &&
            latitude.HasValue &&
            longitude.Value >=
                bounds.MinLongitude &&
            longitude.Value <=
                bounds.MaxLongitude &&
            latitude.Value >=
                bounds.MinLatitude &&
            latitude.Value <=
                bounds.MaxLatitude;
    }

    private static KentRehberiFeature?
        WithDistance(
            KentRehberiFeature feature,
            double longitude,
            double latitude)
    {
        var candidateLongitude =
            feature.Properties.X;
        var candidateLatitude =
            feature.Properties.Y;

        if (!candidateLongitude.HasValue ||
            !candidateLatitude.HasValue)
        {
            return null;
        }

        var distance =
            HaversineMeters(
                longitude,
                latitude,
                candidateLongitude.Value,
                candidateLatitude.Value);

        var properties =
            feature.Properties with
            {
                DistanceMeters = distance
            };

        return feature with
        {
            Properties = properties
        };
    }

    private static double HaversineMeters(
        double longitude1,
        double latitude1,
        double longitude2,
        double latitude2)
    {
        const double earthRadiusMeters =
            6_371_008.8d;

        var latitudeDelta =
            DegreesToRadians(
                latitude2 -
                latitude1);
        var longitudeDelta =
            DegreesToRadians(
                longitude2 -
                longitude1);
        var latitude1Radians =
            DegreesToRadians(
                latitude1);
        var latitude2Radians =
            DegreesToRadians(
                latitude2);

        var sinLatitude =
            Math.Sin(
                latitudeDelta / 2d);
        var sinLongitude =
            Math.Sin(
                longitudeDelta / 2d);

        var haversine =
            sinLatitude *
            sinLatitude +
            Math.Cos(
                latitude1Radians) *
            Math.Cos(
                latitude2Radians) *
            sinLongitude *
            sinLongitude;

        var angularDistance =
            2d *
            Math.Atan2(
                Math.Sqrt(
                    haversine),
                Math.Sqrt(
                    Math.Max(
                        0d,
                        1d -
                        haversine)));

        return earthRadiusMeters *
            angularDistance;
    }

    private static double DegreesToRadians(
        double degrees) =>
        degrees *
        Math.PI /
        180d;

    private static IReadOnlyList<
        KentRehberiTypeSample>
        BuildSamples(
            IReadOnlyList<KentRehberiFeature> features,
            int maximumSamples)
    {
        if (features.Count == 0 ||
            maximumSamples <= 0)
        {
            return Array.Empty<
                KentRehberiTypeSample>();
        }

        if (features.Count <=
            maximumSamples)
        {
            return features
                .Select(
                    ToSample)
                .ToArray();
        }

        var indices =
            SelectDistributedIndices(
                features.Count,
                maximumSamples);

        return indices
            .Select(
                index =>
                    ToSample(
                        features[index]))
            .ToArray();
    }

    private static IReadOnlyList<int>
        SelectDistributedIndices(
            int count,
            int maximumSamples)
    {
        if (count <= 0 ||
            maximumSamples <= 0)
        {
            return Array.Empty<int>();
        }

        if (maximumSamples == 1)
        {
            return new[]
            {
                count / 2
            };
        }

        var indices =
            new SortedSet<int>();

        for (var index = 0;
             index < maximumSamples;
             index++)
        {
            var fraction =
                index /
                (double)(
                    maximumSamples -
                    1);

            var candidate =
                (int)Math.Round(
                    fraction *
                    (count - 1),
                    MidpointRounding.AwayFromZero);

            indices.Add(
                Math.Clamp(
                    candidate,
                    0,
                    count - 1));
        }

        for (var candidate = 0;
             indices.Count <
                 maximumSamples &&
             candidate <
                 count;
             candidate++)
        {
            indices.Add(
                candidate);
        }

        return indices
            .Take(
                maximumSamples)
            .ToArray();
    }

    private static KentRehberiTypeSample
        ToSample(
            KentRehberiFeature feature) =>
        new(
            feature.Id,
            feature.Properties.Adi,
            feature.Properties.Adres,
            feature.Properties.DurakNo);
}
