using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CityWorks.UserApi.Gis
{
    /// <summary>
    /// Restricts user-supplied proxy payload memory and prevents an upstream
    /// GIS endpoint from becoming a same-origin active-document host.
    /// Neither rule depends on a client-controlled Content-Length header.
    /// </summary>
    public static class GisProxyPayloadPolicy
    {
        private const int ReadBlockBytes = 16 * 1024;

        private static readonly HashSet<string> ActiveMediaTypes =
            new(StringComparer.OrdinalIgnoreCase)
            {
                "text/html",
                "application/xhtml+xml",
                "image/svg+xml",
                "application/svg+xml",
                "text/x-html",
                "text/javascript",
                "application/javascript",
                "text/x-javascript",
                "application/x-javascript",
                "text/ecmascript",
                "application/ecmascript",
                "application/x-ecmascript",
                "text/css",
                "text/xml",
                "application/xml"
            };

        public static bool IsActiveContentType(string contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType)) return false;
            var separator = contentType.IndexOf(';');
            var mediaType = (separator < 0 ? contentType : contentType.Substring(0, separator))
                .Trim();
            return ActiveMediaTypes.Contains(mediaType);
        }

        /// <summary>
        /// Only pass through explicitly inert text or structured JSON media types.
        /// Prefix matching (for example application/jsonp) is unsafe because it
        /// can mislabel executable content as JSON. Unknown types become downloads.
        /// </summary>
        public static string NormalizeResponseContentType(string contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType))
                return "application/json; charset=utf-8";

            var separator = contentType.IndexOf(';');
            var mediaType = (separator < 0 ? contentType : contentType.Substring(0, separator))
                .Trim();

            var isJson = string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mediaType, "application/json-seq", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mediaType, "application/x-ndjson", StringComparison.OrdinalIgnoreCase)
                || (mediaType.StartsWith("application/", StringComparison.OrdinalIgnoreCase)
                    && mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
            var isInertText = string.Equals(mediaType, "text/plain", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mediaType, "text/csv", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mediaType, "text/tab-separated-values", StringComparison.OrdinalIgnoreCase);

            return isJson || isInertText ? contentType : "application/octet-stream";
        }

        /// <summary>
        /// A chunked request with no Content-Length may have unbounded length.
        /// Stop at the first excess byte; never call ReadToEndAsync on it.
        /// The existing proxy transports POST form/JSON data as UTF-8 text.
        /// </summary>
        public static async Task<string?> ReadBoundedUtf8BodyAsync(
            Stream input,
            long byteLimit,
            CancellationToken cancellationToken)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            if (byteLimit < 0 || byteLimit > int.MaxValue)
                throw new ArgumentOutOfRangeException(nameof(byteLimit));

            using var output = new MemoryStream();
            var buffer = new byte[ReadBlockBytes];

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var count = await input.ReadAsync(buffer, 0, buffer.Length, cancellationToken)
                    .ConfigureAwait(false);
                if (count == 0) break;

                if (count > byteLimit - output.Length)
                {
                    return null;
                }

                output.Write(buffer, 0, count);
            }

            return Encoding.UTF8.GetString(
                output.GetBuffer(),
                0,
                checked((int)output.Length));
        }
    }
}
