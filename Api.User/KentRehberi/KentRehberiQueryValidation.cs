using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Api.User.KentRehberi;

public sealed record KentRehberiBounds(
    double MinLongitude,
    double MinLatitude,
    double MaxLongitude,
    double MaxLatitude);

public sealed record KentRehberiSearchCriteria(
    string? Ilce,
    string? Mahalle,
    short? Tur,
    string? Query,
    KentRehberiBounds? Bounds,
    int? AfterObjectId,
    int Limit);

public sealed record KentRehberiNearbyCriteria(
    double Longitude,
    double Latitude,
    double RadiusMeters,
    string? Ilce,
    string? Mahalle,
    short? Tur,
    string? Query,
    int Limit);

public sealed class KentRehberiValidationException : ArgumentException
{
    public KentRehberiValidationException(
        IReadOnlyDictionary<string, string[]> errors)
        : base("One or more Kent Rehberi query parameters are invalid.")
    {
        Errors = errors;
    }

    public IReadOnlyDictionary<string, string[]> Errors { get; }
}

public static class KentRehberiQueryValidation
{
    public const int MaxDistrictLength = 50;
    public const int MaxNeighborhoodLength = 50;
    public const int MaxQueryLength = 120;

    public static KentRehberiSearchCriteria NormalizeSearch(
        string? ilce,
        string? mahalle,
        short? tur,
        string? query,
        string? bbox,
        int? afterObjectId,
        int? limit,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var errors = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        var normalizedIlce = NormalizeText(ilce, MaxDistrictLength, "ilce", errors);
        var normalizedMahalle = NormalizeText(mahalle, MaxNeighborhoodLength, "mahalle", errors);
        var normalizedQuery = NormalizeText(query, MaxQueryLength, "q", errors);
        var normalizedBounds = ParseBounds(bbox, errors);
        var normalizedLimit = NormalizeLimit(limit, options, errors);

        if (afterObjectId is <= 0)
        {
            AddError(errors, "afterObjectId", "afterObjectId must be greater than zero.");
        }
        else if (afterObjectId.HasValue && !options.ObjectIdCursorEnabled)
        {
            AddError(
                errors,
                "afterObjectId",
                "afterObjectId is disabled until ObjectID uniqueness is verified by the deployment preflight.");
        }

        ThrowIfInvalid(errors);

        return new KentRehberiSearchCriteria(
            normalizedIlce,
            normalizedMahalle,
            tur,
            normalizedQuery,
            normalizedBounds,
            afterObjectId,
            normalizedLimit);
    }

    public static KentRehberiNearbyCriteria NormalizeNearby(
        double? longitude,
        double? latitude,
        double? radiusMeters,
        string? ilce,
        string? mahalle,
        short? tur,
        string? query,
        int? limit,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var errors = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        var normalizedIlce = NormalizeText(ilce, MaxDistrictLength, "ilce", errors);
        var normalizedMahalle = NormalizeText(mahalle, MaxNeighborhoodLength, "mahalle", errors);
        var normalizedQuery = NormalizeText(query, MaxQueryLength, "q", errors);
        var normalizedLimit = NormalizeLimit(limit, options, errors);

        if (!longitude.HasValue || !double.IsFinite(longitude.Value) ||
            longitude.Value is < -180 or > 180)
        {
            AddError(errors, "lon", "lon must be a finite longitude between -180 and 180.");
        }

        if (!latitude.HasValue || !double.IsFinite(latitude.Value) ||
            latitude.Value is < -90 or > 90)
        {
            AddError(errors, "lat", "lat must be a finite latitude between -90 and 90.");
        }

        var normalizedRadius = radiusMeters ?? 2_000d;
        if (!double.IsFinite(normalizedRadius) ||
            normalizedRadius <= 0 ||
            normalizedRadius > options.MaxRadiusMeters)
        {
            AddError(
                errors,
                "radiusMeters",
                $"radiusMeters must be greater than zero and at most {options.MaxRadiusMeters}.");
        }

        ThrowIfInvalid(errors);

        return new KentRehberiNearbyCriteria(
            longitude!.Value,
            latitude!.Value,
            normalizedRadius,
            normalizedIlce,
            normalizedMahalle,
            tur,
            normalizedQuery,
            normalizedLimit);
    }

    public static string EscapeLikePattern(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);
    }

    private static string? NormalizeText(
        string? value,
        int maxLength,
        string field,
        IDictionary<string, List<string>> errors)
    {
        var normalized = value?.Trim();
        if (string.IsNullOrEmpty(normalized))
        {
            return null;
        }

        if (normalized.Length > maxLength)
        {
            AddError(errors, field, $"{field} cannot exceed {maxLength} characters.");
            return null;
        }

        if (normalized.Any(char.IsControl))
        {
            AddError(errors, field, $"{field} cannot contain control characters.");
            return null;
        }

        return normalized;
    }

    private static KentRehberiBounds? ParseBounds(
        string? bbox,
        IDictionary<string, List<string>> errors)
    {
        if (string.IsNullOrWhiteSpace(bbox))
        {
            return null;
        }

        var parts = bbox.Split(',', StringSplitOptions.TrimEntries);
        if (parts.Length != 4)
        {
            AddError(
                errors,
                "bbox",
                "bbox must contain minLon,minLat,maxLon,maxLat.");
            return null;
        }

        var parsed = new double[4];
        for (var index = 0; index < parts.Length; index++)
        {
            if (!double.TryParse(
                    parts[index],
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out parsed[index]) ||
                !double.IsFinite(parsed[index]))
            {
                AddError(errors, "bbox", "bbox values must be finite decimal numbers.");
                return null;
            }
        }

        var bounds = new KentRehberiBounds(
            parsed[0],
            parsed[1],
            parsed[2],
            parsed[3]);

        if (bounds.MinLongitude is < -180 or > 180 ||
            bounds.MaxLongitude is < -180 or > 180 ||
            bounds.MinLatitude is < -90 or > 90 ||
            bounds.MaxLatitude is < -90 or > 90)
        {
            AddError(errors, "bbox", "bbox coordinates must be valid EPSG:4326 coordinates.");
            return null;
        }

        if (bounds.MinLongitude >= bounds.MaxLongitude ||
            bounds.MinLatitude >= bounds.MaxLatitude)
        {
            AddError(
                errors,
                "bbox",
                "bbox minimum coordinates must be smaller than maximum coordinates.");
            return null;
        }

        return bounds;
    }

    private static int NormalizeLimit(
        int? limit,
        KentRehberiOptions options,
        IDictionary<string, List<string>> errors)
    {
        var normalized = limit ?? options.DefaultLimit;
        if (normalized < 1 || normalized > options.MaxLimit)
        {
            AddError(
                errors,
                "limit",
                $"limit must be between 1 and {options.MaxLimit}.");
        }

        return normalized;
    }

    private static void AddError(
        IDictionary<string, List<string>> errors,
        string field,
        string message)
    {
        if (!errors.TryGetValue(field, out var messages))
        {
            messages = new List<string>();
            errors[field] = messages;
        }

        messages.Add(message);
    }

    private static void ThrowIfInvalid(
        IDictionary<string, List<string>> errors)
    {
        if (errors.Count == 0)
        {
            return;
        }

        throw new KentRehberiValidationException(
            errors.ToDictionary(
                pair => pair.Key,
                pair => pair.Value.Distinct(StringComparer.Ordinal).ToArray(),
                StringComparer.OrdinalIgnoreCase));
    }
}
