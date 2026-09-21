using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Api.User.KentRehberi;

public static class KentRehberiQueryFingerprint
{
    public static string ForSearch(KentRehberiSearchCriteria criteria)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        var canonical = new StringBuilder(256);
        canonical.Append("search|");
        Append(canonical, criteria.Ilce);
        Append(canonical, criteria.Mahalle);
        Append(canonical, criteria.Tur);
        Append(canonical, criteria.Query);

        if (criteria.Bounds is null)
        {
            canonical.Append("bbox:-|");
        }
        else
        {
            canonical.Append("bbox:");
            AppendDouble(canonical, criteria.Bounds.MinLongitude);
            canonical.Append(',');
            AppendDouble(canonical, criteria.Bounds.MinLatitude);
            canonical.Append(',');
            AppendDouble(canonical, criteria.Bounds.MaxLongitude);
            canonical.Append(',');
            AppendDouble(canonical, criteria.Bounds.MaxLatitude);
            canonical.Append('|');
        }

        canonical.Append("after:");
        canonical.Append(criteria.AfterObjectId?.ToString(CultureInfo.InvariantCulture) ?? "-");
        canonical.Append('|');
        canonical.Append("limit:");
        canonical.Append(criteria.Limit.ToString(CultureInfo.InvariantCulture));

        return Hash(canonical.ToString());
    }

    public static string ForNearby(KentRehberiNearbyCriteria criteria)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        var canonical = new StringBuilder(256);
        canonical.Append("nearby|");
        AppendDouble(canonical, criteria.Longitude);
        canonical.Append('|');
        AppendDouble(canonical, criteria.Latitude);
        canonical.Append('|');
        AppendDouble(canonical, criteria.RadiusMeters);
        canonical.Append('|');
        Append(canonical, criteria.Ilce);
        Append(canonical, criteria.Mahalle);
        Append(canonical, criteria.Tur);
        Append(canonical, criteria.Query);
        canonical.Append("limit:");
        canonical.Append(criteria.Limit.ToString(CultureInfo.InvariantCulture));

        return Hash(canonical.ToString());
    }

    public static string ForObjectId(int objectId)
    {
        if (objectId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(objectId),
                "objectId must be greater than zero.");
        }

        return Hash(
            "object|" +
            objectId.ToString(CultureInfo.InvariantCulture));
    }

    public static string Hash(string canonical)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(canonical);

        var bytes = Encoding.UTF8.GetBytes(canonical);
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(bytes, digest);
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    private static void Append(
        StringBuilder builder,
        string? value)
    {
        builder.Append(value is null ? "-" : Escape(value));
        builder.Append('|');
    }

    private static void Append(
        StringBuilder builder,
        short? value)
    {
        builder.Append(
            value?.ToString(CultureInfo.InvariantCulture) ?? "-");
        builder.Append('|');
    }

    private static string Escape(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("|", "\\|", StringComparison.Ordinal)
            .Replace(":", "\\:", StringComparison.Ordinal);
    }

    private static void AppendDouble(
        StringBuilder builder,
        double value)
    {
        if (!double.IsFinite(value))
        {
            throw new ArgumentOutOfRangeException(
                nameof(value),
                "Fingerprint coordinates must be finite.");
        }

        builder.Append(
            value.ToString("R", CultureInfo.InvariantCulture));
    }
}
