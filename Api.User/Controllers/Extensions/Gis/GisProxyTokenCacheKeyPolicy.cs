using System;
using System.Security.Cryptography;
using System.Text;

namespace CityWorks.UserApi.Gis;

/// <summary>
/// Partitions GIS authentication tokens by both endpoint and credential identity.
/// A shared service URL is not an authorization boundary: accounts on the same
/// server may have entirely different GIS layer entitlements.
/// </summary>
public static class GisProxyTokenCacheKeyPolicy
{
    private const string Prefix = "gis-token:v2:";

    public static string Create(string serviceUrl, string userName, string password)
    {
        if (string.IsNullOrWhiteSpace(serviceUrl))
            throw new ArgumentException("GIS endpoint is required.", nameof(serviceUrl));
        if (string.IsNullOrWhiteSpace(userName))
            throw new ArgumentException("GIS user identity is required.", nameof(userName));
        if (string.IsNullOrWhiteSpace(password))
            throw new ArgumentException("GIS authentication credential is required.", nameof(password));

        // Length-delimited values avoid collisions when URLs and credentials
        // contain delimiter characters. Do not log or cache this clear-text
        // material; only the fixed-length digest becomes the cache key.
        var material = new StringBuilder(serviceUrl.Length + userName.Length + password.Length + 48);
        AppendField(material, serviceUrl);
        AppendField(material, userName);
        AppendField(material, password);
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(material.ToString()));
        return Prefix + Convert.ToHexString(digest);
    }

    private static void AppendField(StringBuilder target, string value)
    {
        target.Append(value.Length).Append(':').Append(value);
    }
}
