using System;
using System.Linq;

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
        // Only the root route identifies the portal flavor. A later service/layer
        // segment named "webgis" must not switch the authentication endpoint.
        var usesWebGis = pathSegments.Length > 0 &&
            string.Equals(pathSegments[0], "webgis", StringComparison.OrdinalIgnoreCase);
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
