using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using System;
using System.Text;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Computes bounded header metadata without retaining header values. This deliberately avoids
    /// copying Authorization, Cookie, forwarded-address, or application-specific values into any
    /// diagnostic object.
    /// </summary>
    public static class RequestHeaderInspector
    {
        public static RequestHeaderSnapshot Inspect(IHeaderDictionary headers)
        {
            if (headers == null)
            {
                throw new ArgumentNullException(nameof(headers));
            }

            long totalBytes = 0;
            var valueCount = 0;

            foreach (var pair in headers)
            {
                totalBytes = SaturatingAdd(totalBytes, Utf8Length(pair.Key));
                totalBytes = SaturatingAdd(totalBytes, 2); // ": "

                StringValues values = pair.Value;
                valueCount = SaturatingAdd(valueCount, values.Count);

                for (var index = 0; index < values.Count; index++)
                {
                    var value = values[index] ?? string.Empty;
                    totalBytes = SaturatingAdd(totalBytes, Utf8Length(value));

                    if (index + 1 < values.Count)
                    {
                        totalBytes = SaturatingAdd(totalBytes, 2); // ", "
                    }
                }

                totalBytes = SaturatingAdd(totalBytes, 2); // CRLF framing estimate.
            }

            return new RequestHeaderSnapshot(
                headerCount: headers.Count,
                headerValueCount: valueCount,
                estimatedUtf8Bytes: totalBytes,
                authorizationBytes: GetHeaderUtf8Length(headers, "Authorization"),
                cookieBytes: GetHeaderUtf8Length(headers, "Cookie"),
                contentTypeBytes: GetHeaderUtf8Length(headers, "Content-Type"),
                forwardedForBytes: GetHeaderUtf8Length(headers, "X-Forwarded-For"),
                authorizationValueCount: GetHeaderValueCount(headers, "Authorization"),
                contentLengthValueCount: GetHeaderValueCount(headers, "Content-Length"),
                transferEncodingValueCount: GetHeaderValueCount(headers, "Transfer-Encoding"),
                hostValueCount: GetHeaderValueCount(headers, "Host"));
        }

        public static long GetHeaderUtf8Length(IHeaderDictionary headers, string headerName)
        {
            if (headers == null || string.IsNullOrWhiteSpace(headerName))
            {
                return 0;
            }

            if (!headers.TryGetValue(headerName, out var values))
            {
                return 0;
            }

            long total = 0;
            for (var index = 0; index < values.Count; index++)
            {
                total = SaturatingAdd(total, Utf8Length(values[index] ?? string.Empty));
                if (index + 1 < values.Count)
                {
                    total = SaturatingAdd(total, 2);
                }
            }

            return total;
        }

        public static int GetHeaderValueCount(IHeaderDictionary headers, string headerName)
        {
            if (headers == null || string.IsNullOrWhiteSpace(headerName))
            {
                return 0;
            }

            return headers.TryGetValue(headerName, out var values) ? values.Count : 0;
        }

        public static bool ContainsNewline(IHeaderDictionary headers)
        {
            if (headers == null)
            {
                return false;
            }

            foreach (var pair in headers)
            {
                foreach (var value in pair.Value)
                {
                    if (value != null && (value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Detects field-value octets that are forbidden by HTTP field-value grammar even when a
        /// hosting adapter has materialized them into <see cref="IHeaderDictionary"/>. Horizontal
        /// tab is intentionally retained because HTTP permits it as optional whitespace. CR/LF are
        /// handled by <see cref="ContainsNewline"/> so callers can preserve the more specific
        /// rejection reason. DEL and C0 controls are rejected fail-closed.
        /// </summary>
        public static bool ContainsInvalidControlCharacter(IHeaderDictionary headers)
        {
            if (headers == null)
            {
                return false;
            }

            foreach (var pair in headers)
            {
                foreach (var value in pair.Value)
                {
                    if (ContainsInvalidControlCharacter(value))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        internal static bool ContainsInvalidControlCharacter(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (character == '\r' || character == '\n' || character == '\t')
                {
                    continue;
                }

                if (character < 0x20 || character == 0x7f)
                {
                    return true;
                }
            }

            return false;
        }

        private static int Utf8Length(string value)
        {
            return string.IsNullOrEmpty(value) ? 0 : Encoding.UTF8.GetByteCount(value);
        }

        private static long SaturatingAdd(long left, long right)
        {
            if (left >= long.MaxValue - right)
            {
                return long.MaxValue;
            }

            return left + right;
        }

        private static int SaturatingAdd(int left, int right)
        {
            if (right <= 0)
            {
                return left;
            }

            return left > int.MaxValue - right ? int.MaxValue : left + right;
        }
    }

    public readonly struct RequestHeaderSnapshot
    {
        public RequestHeaderSnapshot(
            int headerCount,
            int headerValueCount,
            long estimatedUtf8Bytes,
            long authorizationBytes,
            long cookieBytes,
            long contentTypeBytes,
            long forwardedForBytes,
            int authorizationValueCount,
            int contentLengthValueCount,
            int transferEncodingValueCount,
            int hostValueCount)
        {
            HeaderCount = headerCount;
            HeaderValueCount = headerValueCount;
            EstimatedUtf8Bytes = estimatedUtf8Bytes;
            AuthorizationBytes = authorizationBytes;
            CookieBytes = cookieBytes;
            ContentTypeBytes = contentTypeBytes;
            ForwardedForBytes = forwardedForBytes;
            AuthorizationValueCount = authorizationValueCount;
            ContentLengthValueCount = contentLengthValueCount;
            TransferEncodingValueCount = transferEncodingValueCount;
            HostValueCount = hostValueCount;
        }

        public int HeaderCount { get; }
        public int HeaderValueCount { get; }
        public long EstimatedUtf8Bytes { get; }
        public long AuthorizationBytes { get; }
        public long CookieBytes { get; }
        public long ContentTypeBytes { get; }
        public long ForwardedForBytes { get; }
        public int AuthorizationValueCount { get; }
        public int ContentLengthValueCount { get; }
        public int TransferEncodingValueCount { get; }
        public int HostValueCount { get; }
    }
}
