using System;

namespace CityWorks.UserApi.Gis;

/// <summary>
/// Builds the server-side GIS token endpoint from a configured HTTPS service URI.
/// Preserve non-default ports, choose the token route by a complete path segment,
/// and never forward query strings or user-info from the service URI.
/// </summary>
public static class GisProxyTokenEndpointPolicy
{
    public static Uri Create(Uri serviceUri)
    {
        if (serviceUri is null)
            throw new ArgumentNullException(nameof(serviceUri));
        if (!serviceUri.IsAbsoluteUri || !string.Equals(
                serviceUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("GIS token endpoints require an absolute HTTPS URI.", nameof(serviceUri));
        }
        if (!string.IsNullOrEmpty(serviceUri.UserInfo))
            throw new ArgumentException("GIS service URLs must not embed credentials.", nameof(serviceUri));

        var pathSegments = serviceUri.AbsolutePath.Split(
            '/', StringSplitOptions.RemoveEmptyEntries);
        // A tenant prefix may precede the WebGIS root, but a "webgis" segment
        // inside /arcgis/rest/services/<service-name> is only a resource name.
        var webGisIndex = Array.FindIndex(pathSegments, segment =>
            string.Equals(segment, "webgis", StringComparison.OrdinalIgnoreCase));
        var arcGisIndex = Array.FindIndex(pathSegments, segment =>
            string.Equals(segment, "arcgis", StringComparison.OrdinalIgnoreCase));
        var restIndex = Array.FindIndex(pathSegments, segment =>
            string.Equals(segment, "rest", StringComparison.OrdinalIgnoreCase));
        var usesWebGis = webGisIndex >= 0
            && (arcGisIndex < 0 || webGisIndex < arcGisIndex)
            && (restIndex < 0 || webGisIndex < restIndex);
        var tokenPath = usesWebGis
            ? "/webgis/tokens/generateToken"
            : "/arcgis/tokens/generateToken";

        // UriBuilder retains a non-default port while discarding path/query/fragment
        // data from the service resource itself.
        return new UriBuilder(
            Uri.UriSchemeHttps,
            serviceUri.Host,
            serviceUri.Port,
            tokenPath).Uri;
    }
}
