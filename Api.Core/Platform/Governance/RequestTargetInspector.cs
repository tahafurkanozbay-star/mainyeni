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
        private static readonly string[] EncodedSeparatorTokens =
        {
            "%2f",
            "%5c",
            "%252f",
            "%255c"
        };

        private static readonly string[] EncodedTraversalTokens =
        {
            "%2e%2e",
            "%2e.",
            ".%2e",
            "%252e%252e",
            "%252e.",
            ".%252e"
        };

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
                containsBackslash: path.IndexOf('\') >= 0,
                containsPlainTraversal: ContainsPlainTraversal(path),
                containsEncodedSeparator: ContainsAny(path, EncodedSeparatorTokens),
                containsEncodedTraversal: ContainsAny(path, EncodedTraversalTokens));
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
