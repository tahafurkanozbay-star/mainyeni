using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Content-type parsing and body-method policy. Incoming Content-Type values are parsed with the
    /// ASP.NET Core HTTP header parser instead of ad-hoc string splitting, while configured allowlist
    /// entries use a deliberately small wildcard grammar.
    /// </summary>
    public static class RequestContentPolicy
    {
        public static bool MethodCanCarryBody(string method)
        {
            return HttpMethods.IsPost(method) ||
                   HttpMethods.IsPut(method) ||
                   HttpMethods.IsPatch(method) ||
                   HttpMethods.IsDelete(method);
        }

        public static bool HasBody(HttpRequest request)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            if (request.ContentLength.HasValue)
            {
                return request.ContentLength.Value > 0;
            }

            return request.Headers.ContainsKey("Transfer-Encoding");
        }

        public static bool TryNormalizeMediaType(string contentType, out string mediaType)
        {
            mediaType = string.Empty;
            if (string.IsNullOrWhiteSpace(contentType) ||
                ContainsNewline(contentType) ||
                !MediaTypeHeaderValue.TryParse(contentType, out var parsed) ||
                parsed == null)
            {
                return false;
            }

            var parsedMediaType = parsed.MediaType.ToString().Trim();
            if (!TrySplitMediaType(parsedMediaType, out var type, out var subtype) ||
                type.IndexOf('*') >= 0 ||
                subtype.IndexOf('*') >= 0)
            {
                return false;
            }

            mediaType = string.Concat(type.ToLowerInvariant(), "/", subtype.ToLowerInvariant());
            return true;
        }

        public static string NormalizeMediaType(string contentType)
        {
            return TryNormalizeMediaType(contentType, out var mediaType) ? mediaType : string.Empty;
        }

        public static bool IsAllowed(string contentType, IEnumerable<string> allowedMediaTypes)
        {
            if (!TryNormalizeMediaType(contentType, out var mediaType) || allowedMediaTypes == null)
            {
                return false;
            }

            foreach (var allowed in allowedMediaTypes)
            {
                if (!TryNormalizeAllowedMediaTypePattern(allowed, out var allowedType, out var allowedSubtype))
                {
                    continue;
                }

                if (MatchesAllowedPattern(mediaType, allowedType, allowedSubtype))
                {
                    return true;
                }
            }

            return false;
        }

        public static string[] NormalizeAllowedMediaTypes(IEnumerable<string> values)
        {
            if (values == null)
            {
                return Array.Empty<string>();
            }

            return values
                .Select(NormalizeAllowedMediaTypePattern)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        public static bool TryNormalizeAllowedMediaTypePattern(string value, out string type, out string subtype)
        {
            type = string.Empty;
            subtype = string.Empty;

            if (string.IsNullOrWhiteSpace(value) || ContainsNewline(value))
            {
                return false;
            }

            var candidate = value.Trim();
            var parameterSeparator = candidate.IndexOf(';');
            if (parameterSeparator >= 0)
            {
                candidate = candidate.Substring(0, parameterSeparator).Trim();
            }

            if (!TrySplitMediaType(candidate, out var parsedType, out var parsedSubtype))
            {
                return false;
            }

            if (!IsAllowedTypePattern(parsedType) || !IsAllowedSubtypePattern(parsedSubtype))
            {
                return false;
            }

            // A wildcard type is meaningful only as the complete */* pattern. Accepting */json
            // creates an asymmetric grammar that operators can easily mistake for a suffix rule.
            if (parsedType == "*" && parsedSubtype != "*")
            {
                return false;
            }

            type = parsedType.ToLowerInvariant();
            subtype = parsedSubtype.ToLowerInvariant();
            return true;
        }

        private static string NormalizeAllowedMediaTypePattern(string value)
        {
            return TryNormalizeAllowedMediaTypePattern(value, out var type, out var subtype)
                ? string.Concat(type, "/", subtype)
                : string.Empty;
        }

        private static bool MatchesAllowedPattern(string mediaType, string allowedType, string allowedSubtype)
        {
            if (!TrySplitMediaType(mediaType, out var actualType, out var actualSubtype))
            {
                return false;
            }

            if (allowedType == "*" && allowedSubtype == "*")
            {
                return true;
            }

            if (!string.Equals(actualType, allowedType, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (allowedSubtype == "*")
            {
                return true;
            }

            if (allowedSubtype.StartsWith("*+", StringComparison.Ordinal))
            {
                var suffix = allowedSubtype.Substring(1);
                return actualSubtype.Length > suffix.Length &&
                       actualSubtype.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
            }

            return string.Equals(actualSubtype, allowedSubtype, StringComparison.OrdinalIgnoreCase);
        }

        private static bool TrySplitMediaType(string value, out string type, out string subtype)
        {
            type = string.Empty;
            subtype = string.Empty;

            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            var slash = value.IndexOf('/');
            if (slash <= 0 || slash == value.Length - 1 || slash != value.LastIndexOf('/'))
            {
                return false;
            }

            var parsedType = value.Substring(0, slash).Trim();
            var parsedSubtype = value.Substring(slash + 1).Trim();
            if (parsedType.Length == 0 || parsedSubtype.Length == 0)
            {
                return false;
            }

            type = parsedType;
            subtype = parsedSubtype;
            return true;
        }

        private static bool IsAllowedTypePattern(string value)
        {
            return value == "*" || (value.IndexOf('*') < 0 && IsToken(value));
        }

        private static bool IsAllowedSubtypePattern(string value)
        {
            if (value == "*")
            {
                return true;
            }

            if (value.StartsWith("*+", StringComparison.Ordinal))
            {
                return value.Length > 2 &&
                       value.IndexOf('*', 1) < 0 &&
                       IsToken(value.Substring(2));
            }

            return value.IndexOf('*') < 0 && IsToken(value);
        }

        private static bool IsToken(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            for (var index = 0; index < value.Length; index++)
            {
                if (!IsTokenCharacter(value[index]))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsTokenCharacter(char character)
        {
            if ((character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9'))
            {
                return true;
            }

            switch (character)
            {
                case '!': case '#': case '$': case '%': case '&': case '\'': case '*':
                case '+': case '-': case '.': case '^': case '_': case '`': case '|': case '~':
                    return true;
                default:
                    return false;
            }
        }

        private static bool ContainsNewline(string value)
        {
            return value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0;
        }
    }
}
