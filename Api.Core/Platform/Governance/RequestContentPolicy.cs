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

        public static bool IsAllowed(
            string contentType,
            IReadOnlyCollection<string> allowedMediaTypes)
        {
            var mediaType = NormalizeMediaType(contentType);
            if (string.IsNullOrEmpty(mediaType) || allowedMediaTypes == null)
            {
                return false;
            }

            foreach (var allowed in allowedMediaTypes)
            {
                var normalizedAllowed = NormalizeMediaType(allowed);
                if (string.IsNullOrEmpty(normalizedAllowed))
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

                if (normalizedAllowed == "application/*+json" &&
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
    }
}
