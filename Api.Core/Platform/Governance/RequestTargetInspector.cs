using System;
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
        public static RequestTargetSnapshot Inspect(string rawTarget)
        {
            var value = rawTarget ?? string.Empty;
            var queryIndex = value.IndexOf('?');
            var path = queryIndex < 0 ? value : value.Substring(0, queryIndex);
            var query = queryIndex < 0 || queryIndex == value.Length - 1
                ? string.Empty
                : value.Substring(queryIndex + 1);

            return new RequestTargetSnapshot(
                rawTargetLength: value.Length,
                pathLength: path.Length,
                queryLength: query.Length,
                queryParameterCount: CountQueryParameters(query),
                containsControlCharacters: ContainsControlCharacters(value),
                containsBackslash: path.IndexOf('\\') >= 0,
                containsPlainTraversal: ContainsPlainTraversal(path),
                containsEncodedSeparator: ContainsEncodedSeparator(path),
                containsEncodedTraversal: ContainsEncodedTraversal(path));
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
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            var start = 0;
            for (var index = 0; index <= path.Length; index++)
            {
                var atEnd = index == path.Length;
                var separator = !atEnd && path[index] == '/';
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

        /// <summary>
        /// Detects slash and backslash separators encoded through one or more layers of percent
        /// escaping. A fixed token list is intentionally avoided: an attacker can add another
        /// encoded-percent layer (for example %25252f) without changing the eventual separator.
        /// </summary>
        internal static bool ContainsEncodedSeparator(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            for (var index = 0; index < path.Length; index++)
            {
                if (!TryReadSeparator(path, index, out var consumed, out var encoded) || !encoded)
                {
                    continue;
                }

                return true;
            }

            return false;
        }

        /// <summary>
        /// Detects a traversal segment that becomes exactly ".." when percent-encoded dots and
        /// separators are recursively resolved. Only dot/separator tokens are interpreted; other
        /// percent escapes remain opaque, which keeps the scanner allocation-free and prevents
        /// query or unrelated path data from being normalized unexpectedly.
        /// </summary>
        internal static bool ContainsEncodedTraversal(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            var index = 0;
            while (index < path.Length)
            {
                var encodedBoundary = false;
                while (TryReadSeparator(path, index, out var boundaryLength, out var boundaryEncoded))
                {
                    encodedBoundary |= boundaryEncoded;
                    index += boundaryLength;
                }

                if (index >= path.Length)
                {
                    break;
                }

                var dots = 0;
                var segmentContainsOnlyDots = true;
                var encodedComponent = encodedBoundary;

                while (index < path.Length)
                {
                    if (TryReadSeparator(path, index, out _, out var separatorEncoded))
                    {
                        encodedComponent |= separatorEncoded;
                        break;
                    }

                    if (TryReadDot(path, index, out var dotLength, out var dotEncoded))
                    {
                        dots++;
                        encodedComponent |= dotEncoded;
                        index += dotLength;
                        continue;
                    }

                    segmentContainsOnlyDots = false;
                    index++;
                }

                if (segmentContainsOnlyDots && dots == 2 && encodedComponent)
                {
                    return true;
                }
            }

            return false;
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

        private static bool TryReadSeparator(
            string value,
            int index,
            out int consumed,
            out bool encoded)
        {
            consumed = 0;
            encoded = false;

            if (index < 0 || index >= value.Length)
            {
                return false;
            }

            var character = value[index];
            if (character == '/' || character == '\\')
            {
                consumed = 1;
                return true;
            }

            if (TryReadNestedPercentByte(value, index, '2', 'f', out consumed) ||
                TryReadNestedPercentByte(value, index, '5', 'c', out consumed))
            {
                encoded = true;
                return true;
            }

            consumed = 0;
            return false;
        }

        private static bool TryReadDot(
            string value,
            int index,
            out int consumed,
            out bool encoded)
        {
            consumed = 0;
            encoded = false;

            if (index < 0 || index >= value.Length)
            {
                return false;
            }

            if (value[index] == '.')
            {
                consumed = 1;
                return true;
            }

            if (TryReadNestedPercentByte(value, index, '2', 'e', out consumed))
            {
                encoded = true;
                return true;
            }

            consumed = 0;
            return false;
        }

        private static bool TryReadNestedPercentByte(
            string value,
            int index,
            char firstHex,
            char secondHex,
            out int consumed)
        {
            consumed = 0;
            if (index < 0 || index >= value.Length || value[index] != '%')
            {
                return false;
            }

            var cursor = index + 1;
            while (cursor + 1 < value.Length &&
                   value[cursor] == '2' &&
                   value[cursor + 1] == '5')
            {
                cursor += 2;
            }

            if (cursor + 1 >= value.Length ||
                !HexEquals(value[cursor], firstHex) ||
                !HexEquals(value[cursor + 1], secondHex))
            {
                return false;
            }

            consumed = cursor + 2 - index;
            return true;
        }

        private static bool HexEquals(char actual, char expected)
        {
            if (actual == expected)
            {
                return true;
            }

            if (expected >= 'a' && expected <= 'f')
            {
                return actual == char.ToUpperInvariant(expected);
            }

            return false;
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
            bool containsEncodedTraversal)
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
    }
}
