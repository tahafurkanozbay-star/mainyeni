using System;
using System.Globalization;
using System.Text.Json;

namespace CityWorks.UserApi.Gis;

/// <summary>
/// Validates the ArcGIS token response and derives a cache lifetime from the
/// upstream expiry. Tokens are never cached beyond the requested lifetime or
/// the server-declared expiry minus a safety margin.
/// </summary>
public static class GisProxyTokenResponsePolicy
{
    private const int MaxResponseCharacters = 64 * 1024;
    private const int MaxTokenCharacters = 8192;

    public static bool TryReadToken(
        string responseContent,
        DateTimeOffset now,
        TimeSpan requestedLifetime,
        TimeSpan safetyMargin,
        out string token,
        out TimeSpan cacheLifetime)
    {
        token = null;
        cacheLifetime = TimeSpan.Zero;

        if (requestedLifetime <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(requestedLifetime));
        if (safetyMargin < TimeSpan.Zero || safetyMargin >= requestedLifetime)
            throw new ArgumentOutOfRangeException(nameof(safetyMargin));

        if (string.IsNullOrWhiteSpace(responseContent) ||
            responseContent.Length > MaxResponseCharacters)
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(
                responseContent,
                new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                root.TryGetProperty("error", out _) ||
                !root.TryGetProperty("token", out var tokenElement) ||
                tokenElement.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            var candidate = tokenElement.GetString();
            if (!IsSafeToken(candidate)) return false;

            var effectiveLifetime = requestedLifetime - safetyMargin;
            if (root.TryGetProperty("expires", out var expiresElement))
            {
                if (!TryReadExpirationMilliseconds(expiresElement, out var expiresMilliseconds))
                    return false;

                DateTimeOffset expiresAt;
                try
                {
                    expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(expiresMilliseconds);
                }
                catch (ArgumentOutOfRangeException)
                {
                    return false;
                }

                var remaining = expiresAt - now;
                if (remaining <= safetyMargin) return false;

                var boundedRemaining = remaining < requestedLifetime
                    ? remaining
                    : requestedLifetime;
                effectiveLifetime = boundedRemaining - safetyMargin;
            }

            if (effectiveLifetime <= TimeSpan.Zero) return false;

            token = candidate;
            cacheLifetime = effectiveLifetime;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryReadExpirationMilliseconds(JsonElement value, out long milliseconds)
    {
        if (value.ValueKind == JsonValueKind.Number)
            return value.TryGetInt64(out milliseconds);

        if (value.ValueKind == JsonValueKind.String)
        {
            return long.TryParse(
                value.GetString(),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out milliseconds);
        }

        milliseconds = 0;
        return false;
    }

    private static bool IsSafeToken(string token)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > MaxTokenCharacters)
            return false;

        foreach (var character in token)
        {
            if (char.IsControl(character) || char.IsWhiteSpace(character))
                return false;
        }

        return true;
    }
}
