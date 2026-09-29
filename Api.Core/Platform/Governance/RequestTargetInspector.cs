using System;
using System.Buffers;
using System.Collections.Generic;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Allocation-conscious inspection helpers for the raw request target. The checks operate on
    /// the path/query text supplied by the HTTP server before model binding and controller logic,
    /// which allows malformed or intentionally expensive targets to be rejected early.
    /// </summary>
    public static class RequestTargetInspector
    {
        private const int MaxPercentDecodePasses = 8;

        public static RequestTargetSnapshot Inspect(string rawTarget)
        {
            var value = rawTarget ?? string.Empty;
            var queryIndex = value.IndexOf('?');
            var path = queryIndex < 0 ? value : value.Substring(0, queryIndex);
            var query = queryIndex < 0 || queryIndex == value.Length - 1
                ? string.Empty
                : value.Substring(queryIndex + 1);
            var containsPlainTraversal = ContainsPlainTraversal(path);
            var encodedPath = InspectEncodedPath(path, containsPlainTraversal);

            return new RequestTargetSnapshot(
                rawTargetLength: value.Length,
                pathLength: path.Length,
                queryLength: query.Length,
                queryParameterCount: CountQueryParameters(query),
                containsControlCharacters: ContainsControlCharacters(value),
                containsBackslash: path.IndexOf('\\') >= 0,
                containsPlainTraversal: containsPlainTraversal,
                containsEncodedSeparator: encodedPath.ContainsSeparator,
                containsEncodedTraversal: encodedPath.ContainsTraversal,
                percentDecodingDepthExceeded: encodedPath.DepthExceeded);
        }

        public static int CountQueryParameters(string query)
        {
            if (string.IsNullOrEmpty(query))
            {
                return 0;
            }

            var count = 0;
            var segmentHasData = false;

            for (var index = 0; index < query.Length; index++)
            {
                var character = query[index];
                if (character == '&' || character == ';')
                {
                    if (segmentHasData)
                    {
                        count++;
                        segmentHasData = false;
                    }
                    continue;
                }

                if (!char.IsWhiteSpace(character))
                {
                    segmentHasData = true;
                }
            }

            if (segmentHasData)
            {
                count++;
            }

            return count;
        }

        public static bool ContainsControlCharacters(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            foreach (var character in value)
            {
                if (character == '\t')
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

        public static bool ContainsPlainTraversal(string path)
        {
            return ContainsPlainTraversal(path.AsSpan());
        }

        public static bool ContainsAny(string value, IReadOnlyList<string> needles)
        {
            if (string.IsNullOrEmpty(value) || needles == null)
            {
                return false;
            }

            for (var index = 0; index < needles.Count; index++)
            {
                var needle = needles[index];
                if (string.IsNullOrEmpty(needle))
                {
                    continue;
                }

                if (value.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }

            return false;
        }

        private static EncodedPathInspection InspectEncodedPath(
            string path,
            bool containsPlainTraversal)
        {
            if (string.IsNullOrEmpty(path) || path.IndexOf('%') < 0)
            {
                return default;
            }

            var first = ArrayPool<char>.Shared.Rent(path.Length);
            var second = ArrayPool<char>.Shared.Rent(path.Length);

            try
            {
                ReadOnlySpan<char> source = path.AsSpan();
                var destination = first;
                var containsSeparator = false;
                var containsTraversal = false;

                for (var pass = 0; pass < MaxPercentDecodePasses; pass++)
                {
                    var written = DecodePercentTriplets(
                        source,
                        destination.AsSpan(0, path.Length),
                        out var decodedAny,
                        out var decodedSeparator);

                    if (!decodedAny)
                    {
                        return new EncodedPathInspection(
                            containsSeparator,
                            containsTraversal,
                            depthExceeded: false);
                    }

                    containsSeparator |= decodedSeparator;
                    var decoded = destination.AsSpan(0, written);
                    if (!containsPlainTraversal && ContainsPlainTraversal(decoded))
                    {
                        containsTraversal = true;
                    }

                    if (pass == MaxPercentDecodePasses - 1)
                    {
                        return new EncodedPathInspection(
                            containsSeparator,
                            containsTraversal,
                            ContainsDecodablePercentTriplet(decoded));
                    }

                    source = decoded;
                    destination = ReferenceEquals(destination, first) ? second : first;
                }

                return new EncodedPathInspection(
                    containsSeparator,
                    containsTraversal,
                    depthExceeded: false);
            }
            finally
            {
                ArrayPool<char>.Shared.Return(first);
                ArrayPool<char>.Shared.Return(second);
            }
        }

        private static int DecodePercentTriplets(
            ReadOnlySpan<char> source,
            Span<char> destination,
            out bool decodedAny,
            out bool decodedSeparator)
        {
            decodedAny = false;
            decodedSeparator = false;
            var read = 0;
            var written = 0;

            while (read < source.Length)
            {
                if (source[read] == '%' &&
                    read + 2 < source.Length &&
                    TryHexNibble(source[read + 1], out var high) &&
                    TryHexNibble(source[read + 2], out var low))
                {
                    var decoded = (char)((high << 4) | low);
                    destination[written++] = decoded;
                    decodedAny = true;
                    decodedSeparator |= decoded == '/' || decoded == '\\';
                    read += 3;
                    continue;
                }

                destination[written++] = source[read++];
            }

            return written;
        }

        private static bool ContainsPlainTraversal(ReadOnlySpan<char> path)
        {
            if (path.IsEmpty)
            {
                return false;
            }

            var start = 0;
            for (var index = 0; index <= path.Length; index++)
            {
                var atEnd = index == path.Length;
                var separator = !atEnd && (path[index] == '/' || path[index] == '\\');
                if (!atEnd && !separator)
                {
                    continue;
                }

                var length = index - start;
                if (length == 2 &&
                    path[start] == '.' &&
                    path[start + 1] == '.')
                {
                    return true;
                }

                start = index + 1;
            }

            return false;
        }

        private static bool ContainsDecodablePercentTriplet(ReadOnlySpan<char> value)
        {
            for (var index = 0; index + 2 < value.Length; index++)
            {
                if (value[index] == '%' &&
                    TryHexNibble(value[index + 1], out _) &&
                    TryHexNibble(value[index + 2], out _))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool TryHexNibble(char value, out int nibble)
        {
            if (value >= '0' && value <= '9')
            {
                nibble = value - '0';
                return true;
            }

            if (value >= 'a' && value <= 'f')
            {
                nibble = value - 'a' + 10;
                return true;
            }

            if (value >= 'A' && value <= 'F')
            {
                nibble = value - 'A' + 10;
                return true;
            }

            nibble = 0;
            return false;
        }

        private readonly struct EncodedPathInspection
        {
            public EncodedPathInspection(
                bool containsSeparator,
                bool containsTraversal,
                bool depthExceeded)
            {
                ContainsSeparator = containsSeparator;
                ContainsTraversal = containsTraversal;
                DepthExceeded = depthExceeded;
            }

            public bool ContainsSeparator { get; }

            public bool ContainsTraversal { get; }

            public bool DepthExceeded { get; }
        }
    }

    public readonly struct RequestTargetSnapshot
    {
        public RequestTargetSnapshot(
            int rawTargetLength,
            int pathLength,
            int queryLength,
            int queryParameterCount,
            bool containsControlCharacters,
            bool containsBackslash,
            bool containsPlainTraversal,
            bool containsEncodedSeparator,
            bool containsEncodedTraversal,
            bool percentDecodingDepthExceeded)
        {
            RawTargetLength = rawTargetLength;
            PathLength = pathLength;
            QueryLength = queryLength;
            QueryParameterCount = queryParameterCount;
            ContainsControlCharacters = containsControlCharacters;
            ContainsBackslash = containsBackslash;
            ContainsPlainTraversal = containsPlainTraversal;
            ContainsEncodedSeparator = containsEncodedSeparator;
            ContainsEncodedTraversal = containsEncodedTraversal;
            PercentDecodingDepthExceeded = percentDecodingDepthExceeded;
        }

        public int RawTargetLength { get; }

        public int PathLength { get; }

        public int QueryLength { get; }

        public int QueryParameterCount { get; }

        public bool ContainsControlCharacters { get; }

        public bool ContainsBackslash { get; }

        public bool ContainsPlainTraversal { get; }

        public bool ContainsEncodedSeparator { get; }

        public bool ContainsEncodedTraversal { get; }

        public bool PercentDecodingDepthExceeded { get; }
    }
}
