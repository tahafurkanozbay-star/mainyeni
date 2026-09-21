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
                forwardedForBytes: GetHeaderUtf8Length(headers, "X-Forwarded-For"));
        }

        public static long GetHeaderUtf8Length(
            IHeaderDictionary headers,
            string headerName)
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
                    if (value != null &&
                        (value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static int Utf8Length(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return 0;
            }

            return Encoding.UTF8.GetByteCount(value);
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

            return left > int.MaxValue - right
                ? int.MaxValue
                : left + right;
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
            long forwardedForBytes)
        {
            HeaderCount = headerCount;
            HeaderValueCount = headerValueCount;
            EstimatedUtf8Bytes = estimatedUtf8Bytes;
            AuthorizationBytes = authorizationBytes;
            CookieBytes = cookieBytes;
            ContentTypeBytes = contentTypeBytes;
            ForwardedForBytes = forwardedForBytes;
        }

        public int HeaderCount { get; }

        public int HeaderValueCount { get; }

        public long EstimatedUtf8Bytes { get; }

        public long AuthorizationBytes { get; }

        public long CookieBytes { get; }

        public long ContentTypeBytes { get; }

        public long ForwardedForBytes { get; }
    }
}
