using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Content-type normalization and body-method policy. The policy intentionally accepts only
    /// server-configured media types for requests that can carry application bodies; endpoint-level
    /// model binding remains free to impose narrower constraints.
    /// </summary>
    public static class RequestContentPolicy
    {
        private const string StructuredJsonWildcard = "application/*+json";

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

        public static string NormalizeMediaType(string contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType))
            {
                return string.Empty;
            }

            var value = contentType.Trim();
            var separator = value.IndexOf(';');
            if (separator >= 0)
            {
                value = value.Substring(0, separator);
            }

            return value.Trim().ToLowerInvariant();
        }

        /// <summary>
        /// Returns true only for a concrete request media type made from RFC token characters.
        /// Wildcards are configuration syntax and are never accepted from a request Content-Type.
        /// Parameters are intentionally ignored here because model binding may impose narrower
        /// parameter rules after this coarse platform preflight.
        /// </summary>
        public static bool IsValidRequestMediaType(string contentType)
        {
            var mediaType = NormalizeMediaType(contentType);
            return TrySplitMediaType(mediaType, out var type, out var subtype) &&
                   IsToken(type, allowWildcard: false) &&
                   IsToken(subtype, allowWildcard: false);
        }

        /// <summary>
        /// Validates the bounded pattern grammar supported by the platform allowlist: exact
        /// type/subtype values, type/*, and the existing application/*+json structured suffix
        /// wildcard. Other wildcard placements are rejected rather than silently behaving as an
        /// exact string or broadening the policy unexpectedly.
        /// </summary>
        public static bool IsValidAllowedMediaTypePattern(string contentType)
        {
            var mediaType = NormalizeMediaType(contentType);
            if (!TrySplitMediaType(mediaType, out var type, out var subtype) ||
                !IsToken(type, allowWildcard: false))
            {
                return false;
            }

            if (subtype == "*")
            {
                return true;
            }

            if (string.Equals(mediaType, StructuredJsonWildcard, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return IsToken(subtype, allowWildcard: false);
        }

        public static bool IsAllowed(
            string contentType,
            IEnumerable<string> allowedMediaTypes)
        {
            var mediaType = NormalizeMediaType(contentType);
            if (string.IsNullOrEmpty(mediaType) ||
                allowedMediaTypes == null ||
                !IsValidRequestMediaType(mediaType))
            {
                return false;
            }

            foreach (var allowed in allowedMediaTypes)
            {
                var normalizedAllowed = NormalizeMediaType(allowed);
                if (string.IsNullOrEmpty(normalizedAllowed) ||
                    !IsValidAllowedMediaTypePattern(normalizedAllowed))
                {
                    continue;
                }

                if (string.Equals(mediaType, normalizedAllowed, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                if (normalizedAllowed.EndsWith("/*", StringComparison.Ordinal) &&
                    mediaType.StartsWith(
                        normalizedAllowed.Substring(0, normalizedAllowed.Length - 1),
                        StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                if (string.Equals(normalizedAllowed, StructuredJsonWildcard, StringComparison.OrdinalIgnoreCase) &&
                    mediaType.StartsWith("application/", StringComparison.OrdinalIgnoreCase) &&
                    mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase))
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
                .Select(NormalizeMediaType)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        private static bool TrySplitMediaType(
            string value,
            out string type,
            out string subtype)
        {
            type = string.Empty;
            subtype = string.Empty;

            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            var separator = value.IndexOf('/');
            if (separator <= 0 ||
                separator == value.Length - 1 ||
                value.IndexOf('/', separator + 1) >= 0)
            {
                return false;
            }

            type = value.Substring(0, separator);
            subtype = value.Substring(separator + 1);
            return true;
        }

        private static bool IsToken(string value, bool allowWildcard)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (char.IsAsciiLetterOrDigit(character) ||
                    character == '!' ||
                    character == '#' ||
                    character == '$' ||
                    character == '%' ||
                    character == '&' ||
                    character == '\'' ||
                    character == '+' ||
                    character == '-' ||
                    character == '.' ||
                    character == '^' ||
                    character == '_' ||
                    character == '`' ||
                    character == '|' ||
                    character == '~' ||
                    (allowWildcard && character == '*'))
                {
                    continue;
                }

                return false;
            }

            return true;
        }
    }
}
