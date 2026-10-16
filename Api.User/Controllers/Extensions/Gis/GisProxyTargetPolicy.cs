using System;
using System.Linq;

namespace CityWorks.UserApi.Gis;

/// <summary>
/// Validates the public virtual-host selector and combines only its validated
/// path/query with a server-configured GIS service URI. The public URL never
/// chooses an upstream host.
/// </summary>
public static class GisProxyTargetPolicy
{
    private const string ServiceHostSuffix = ".gissrv.org";

    public static bool TryParsePublicTarget(
        string rawQueryString,
        out Uri publicTarget,
        out string serviceId,
        out string forwardedQuery)
    {
        publicTarget = null;
        serviceId = null;
        forwardedQuery = string.Empty;

        var raw = (rawQueryString ?? string.Empty).TrimStart('?').Trim();
        if (string.IsNullOrWhiteSpace(raw)) return false;

        var querySeparator = raw.IndexOf('?');
        var targetText = querySeparator >= 0 ? raw.Substring(0, querySeparator) : raw;
        forwardedQuery = querySeparator >= 0 ? raw.Substring(querySeparator + 1) : string.Empty;

        if (!Uri.TryCreate(targetText, UriKind.Absolute, out var target) ||
            !string.Equals(target.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !target.Host.EndsWith(ServiceHostSuffix, StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(target.UserInfo))
        {
            return false;
        }

        var hostPrefix = target.Host.Substring(0, target.Host.Length - ServiceHostSuffix.Length);
        if (string.IsNullOrWhiteSpace(hostPrefix) || hostPrefix.Contains('.') || hostPrefix.EndsWith('.'))
        {
            return false;
        }

        if (HasTraversalSegment(targetText))
        {
            return false;
        }

        publicTarget = target;
        serviceId = hostPrefix;
        return true;
    }

    public static Uri BuildUpstreamUri(string configuredUrl, Uri publicTarget, string forwardedQuery)
    {
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var configured) ||
            (configured.Scheme != Uri.UriSchemeHttps && configured.Scheme != Uri.UriSchemeHttp) ||
            !string.IsNullOrEmpty(configured.UserInfo) ||
            publicTarget is null)
        {
            return null;
        }

        var builder = new UriBuilder(configured);
        var basePath = builder.Path.TrimEnd('/');
        var suffixPath = publicTarget.AbsolutePath;
        var baseLastSegment = basePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        var suffixSegments = suffixPath.Split('/', StringSplitOptions.RemoveEmptyEntries).ToList();

        // ArcGIS may append the layer id already present in a configured layer URL.
        if (suffixSegments.Count > 0 &&
            int.TryParse(baseLastSegment, out _) &&
            string.Equals(baseLastSegment, suffixSegments[0], StringComparison.Ordinal))
        {
            suffixSegments.RemoveAt(0);
        }

        builder.Path = suffixSegments.Count == 0
            ? basePath
            : basePath + "/" + string.Join('/', suffixSegments);

        var existingQuery = builder.Query.TrimStart('?');
        var nextQuery = (forwardedQuery ?? string.Empty).TrimStart('?');
        builder.Query = string.IsNullOrWhiteSpace(existingQuery)
            ? nextQuery
            : string.IsNullOrWhiteSpace(nextQuery)
                ? existingQuery
                : existingQuery + "&" + nextQuery;

        return builder.Uri;
    }

    public static Uri AppendQueryParameter(Uri uri, string name, string value)
    {
        if (uri is null) throw new ArgumentNullException(nameof(uri));
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Query parameter name is required.", nameof(name));
        if (value is null) throw new ArgumentNullException(nameof(value));

        var builder = new UriBuilder(uri);
        var existing = builder.Query.TrimStart('?');
        var next = Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(value);
        builder.Query = string.IsNullOrWhiteSpace(existing) ? next : existing + "&" + next;
        return builder.Uri;
    }

    /// <summary>
    /// Replace all existing instances of a credential parameter before adding
    /// the fresh server-issued value. This avoids ambiguous duplicate token
    /// parameters where an upstream server might honor a stale first value.
    /// </summary>
    public static Uri SetQueryParameter(Uri uri, string name, string value)
    {
        if (uri is null) throw new ArgumentNullException(nameof(uri));
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Query parameter name is required.", nameof(name));
        if (value is null) throw new ArgumentNullException(nameof(value));

        var builder = new UriBuilder(uri);
        var existing = builder.Query.TrimStart('?');
        var retained = existing
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(part =>
            {
                var separator = part.IndexOf('=');
                var encodedName = separator < 0 ? part : part.Substring(0, separator);
                string decodedName;
                try
                {
                    decodedName = Uri.UnescapeDataString(encodedName);
                }
                catch (UriFormatException)
                {
                    // A malformed unrelated parameter is preserved rather than
                    // accidentally deleting data while rotating the token.
                    return true;
                }

                return !string.Equals(decodedName, name, StringComparison.OrdinalIgnoreCase);
            })
            .ToList();

        retained.Add(Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(value));
        builder.Query = string.Join("&", retained);
        return builder.Uri;
    }

    private static bool HasTraversalSegment(string targetText)
    {
        var schemeSeparator = targetText.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0) return false;

        var pathStart = targetText.IndexOf('/', schemeSeparator + 3);
        if (pathStart < 0) return false;

        var decoded = targetText.Substring(pathStart);
        // Nested percent encoding must not turn into a traversal segment after
        // a later proxy/server decode. Bound work and fail closed if it never stabilizes.
        for (var pass = 0; pass < 8; pass++)
        {
            string next;
            try
            {
                next = Uri.UnescapeDataString(decoded);
            }
            catch (UriFormatException)
            {
                return true;
            }

            if (next.Contains('\\'))
            {
                return true;
            }

            if (next.Split('/').Any(segment => segment == ".."))
            {
                return true;
            }

            if (string.Equals(next, decoded, StringComparison.Ordinal))
            {
                return false;
            }

            decoded = next;
        }

        return true;
    }
}
