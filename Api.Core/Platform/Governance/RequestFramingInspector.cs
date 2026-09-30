using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using System;
using System.Globalization;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Parses HTTP message framing metadata into a small, value-free snapshot. The inspector never
    /// retains request header contents; it exposes only the state required by governance decisions.
    /// This prevents downstream components from interpreting ambiguous Content-Length or
    /// Transfer-Encoding representations differently.
    /// </summary>
    public static class RequestFramingInspector
    {
        public static RequestFramingSnapshot Inspect(IHeaderDictionary headers)
        {
            if (headers == null)
            {
                throw new ArgumentNullException(nameof(headers));
            }

            var contentLength = InspectContentLength(headers);
            var transferEncoding = InspectTransferEncoding(headers);
            var contentTypeValueCount = headers.TryGetValue("Content-Type", out var contentTypes)
                ? contentTypes.Count
                : 0;

            return new RequestFramingSnapshot(
                contentLength.State,
                contentLength.Value,
                transferEncoding.State,
                transferEncoding.CodingCount,
                contentTypeValueCount);
        }

        private static ContentLengthInspection InspectContentLength(IHeaderDictionary headers)
        {
            if (!headers.TryGetValue("Content-Length", out var values) || values.Count == 0)
            {
                return new ContentLengthInspection(RequestContentLengthState.Absent, null);
            }

            // RFC message framing permits one Content-Length field value. Some HTTP stacks combine
            // repeated field lines into one comma-delimited value, so both representations are
            // rejected rather than accepting a value that a proxy/backend pair could interpret
            // differently.
            if (values.Count != 1)
            {
                return new ContentLengthInspection(RequestContentLengthState.Multiple, null);
            }

            var raw = values[0];
            if (raw == null)
            {
                return new ContentLengthInspection(RequestContentLengthState.Invalid, null);
            }

            var value = TrimOptionalWhitespace(raw);
            if (value.Length == 0)
            {
                return new ContentLengthInspection(RequestContentLengthState.Invalid, null);
            }

            if (value.IndexOf(',') >= 0)
            {
                return new ContentLengthInspection(RequestContentLengthState.Multiple, null);
            }

            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (character < '0' || character > '9')
                {
                    return new ContentLengthInspection(RequestContentLengthState.Invalid, null);
                }
            }

            if (!long.TryParse(
                    value,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var parsed))
            {
                return new ContentLengthInspection(RequestContentLengthState.Invalid, null);
            }

            return new ContentLengthInspection(RequestContentLengthState.Valid, parsed);
        }

        private static TransferEncodingInspection InspectTransferEncoding(IHeaderDictionary headers)
        {
            if (!headers.TryGetValue("Transfer-Encoding", out var values) || values.Count == 0)
            {
                return new TransferEncodingInspection(RequestTransferEncodingState.Absent, 0);
            }

            var codingCount = 0;
            var singleCodingIsChunked = false;
            var malformed = false;
            var unsupported = false;

            for (var valueIndex = 0; valueIndex < values.Count; valueIndex++)
            {
                var raw = values[valueIndex];
                if (raw == null)
                {
                    malformed = true;
                    continue;
                }

                var segmentStart = 0;
                for (var index = 0; index <= raw.Length; index++)
                {
                    var atEnd = index == raw.Length;
                    if (!atEnd && raw[index] != ',')
                    {
                        continue;
                    }

                    var segment = TrimOptionalWhitespace(raw.Substring(segmentStart, index - segmentStart));
                    segmentStart = index + 1;

                    if (segment.Length == 0)
                    {
                        malformed = true;
                        continue;
                    }

                    codingCount++;
                    if (segment.IndexOf(';') >= 0)
                    {
                        // Transfer-coding parameters are not part of the Kent Rehberi request
                        // contract. Rejecting them avoids proxy/backend normalization differences.
                        unsupported = true;
                        continue;
                    }

                    var isChunked = string.Equals(
                        segment,
                        "chunked",
                        StringComparison.OrdinalIgnoreCase);

                    if (codingCount == 1)
                    {
                        singleCodingIsChunked = isChunked;
                    }

                    if (!isChunked)
                    {
                        unsupported = true;
                    }
                }
            }

            if (malformed)
            {
                return new TransferEncodingInspection(
                    RequestTransferEncodingState.Invalid,
                    codingCount);
            }

            if (codingCount > 1)
            {
                return new TransferEncodingInspection(
                    RequestTransferEncodingState.Multiple,
                    codingCount);
            }

            if (codingCount == 0)
            {
                return new TransferEncodingInspection(
                    RequestTransferEncodingState.Invalid,
                    0);
            }

            if (unsupported || !singleCodingIsChunked)
            {
                return new TransferEncodingInspection(
                    RequestTransferEncodingState.Unsupported,
                    codingCount);
            }

            return new TransferEncodingInspection(
                RequestTransferEncodingState.Chunked,
                codingCount);
        }

        private static string TrimOptionalWhitespace(string value)
        {
            var start = 0;
            var end = value.Length - 1;

            while (start <= end && IsOptionalWhitespace(value[start]))
            {
                start++;
            }

            while (end >= start && IsOptionalWhitespace(value[end]))
            {
                end--;
            }

            if (start == 0 && end == value.Length - 1)
            {
                return value;
            }

            return start > end
                ? string.Empty
                : value.Substring(start, end - start + 1);
        }

        private static bool IsOptionalWhitespace(char character)
        {
            return character == ' ' || character == '\t';
        }

        private readonly struct ContentLengthInspection
        {
            public ContentLengthInspection(RequestContentLengthState state, long? value)
            {
                State = state;
                Value = value;
            }

            public RequestContentLengthState State { get; }

            public long? Value { get; }
        }

        private readonly struct TransferEncodingInspection
        {
            public TransferEncodingInspection(RequestTransferEncodingState state, int codingCount)
            {
                State = state;
                CodingCount = codingCount;
            }

            public RequestTransferEncodingState State { get; }

            public int CodingCount { get; }
        }
    }

    public enum RequestContentLengthState
    {
        Absent = 0,
        Valid = 1,
        Multiple = 2,
        Invalid = 3
    }

    public enum RequestTransferEncodingState
    {
        Absent = 0,
        Chunked = 1,
        Multiple = 2,
        Unsupported = 3,
        Invalid = 4
    }

    public readonly struct RequestFramingSnapshot
    {
        public RequestFramingSnapshot(
            RequestContentLengthState contentLengthState,
            long? contentLength,
            RequestTransferEncodingState transferEncodingState,
            int transferCodingCount,
            int contentTypeValueCount)
        {
            ContentLengthState = contentLengthState;
            ContentLength = contentLength;
            TransferEncodingState = transferEncodingState;
            TransferCodingCount = transferCodingCount;
            ContentTypeValueCount = contentTypeValueCount;
        }

        public RequestContentLengthState ContentLengthState { get; }

        public long? ContentLength { get; }

        public RequestTransferEncodingState TransferEncodingState { get; }

        public int TransferCodingCount { get; }

        public int ContentTypeValueCount { get; }

        public bool HasContentLength => ContentLengthState != RequestContentLengthState.Absent;

        public bool HasTransferEncoding => TransferEncodingState != RequestTransferEncodingState.Absent;

        public bool UsesChunkedTransferEncoding => TransferEncodingState == RequestTransferEncodingState.Chunked;
    }
}
