using System;
using System.Collections.Generic;
using System.Text;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Allocation-bounded inspection helpers for the raw request target. Path security checks are
    /// evaluated across a bounded sequence of ASCII percent-decoding passes so mixed/double/triple
    /// encoded traversal and separator payloads cannot bypass a fixed token list. Query values are
    /// deliberately excluded from path canonicalization checks.
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

            var encodedPath = InspectEncodedPath(path);

            return new RequestTargetSnapshot(
                rawTargetLength: value.Length,
                pathLength: path.Length,
                queryLength: query.Length,
                queryParameterCount: CountQueryParameters(query),
                containsControlCharacters: ContainsControlCharacters(value),
                containsBackslash: path.IndexOf('\\') >= 0,
                containsPlainTraversal: ContainsPlainTraversal(path),
                containsEncodedSeparator: encodedPath.ContainsEncodedSeparator,
                containsEncodedTraversal: encodedPath.ContainsEncodedTraversal,
                containsMalformedPercentEncoding: encodedPath.ContainsMalformedPercentEncoding,
                containsEncodedControlCharacter: encodedPath.ContainsEncodedControlCharacter,
                containsOverEncodedReservedSequence: encodedPath.ContainsOverEncodedReservedSequence,
                percentDecodePassCount: encodedPath.PercentDecodePassCount);
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

        private static EncodedPathInspection InspectEncodedPath(string path)
        {
            if (string.IsNullOrEmpty(path) || path.IndexOf('%') < 0)
            {
                return EncodedPathInspection.Empty;
            }

            var current = path;
            var containsEncodedSeparator = false;
            var containsEncodedTraversal = false;
            var containsMalformed = false;
            var containsEncodedControl = false;
            var decodePassCount = 0;

            for (var pass = 0; pass < MaxPercentDecodePasses; pass++)
            {
                var decoded = DecodeAsciiPercentTriplets(current);
                containsEncodedSeparator |= decoded.DecodedSeparator;
                containsMalformed |= decoded.MalformedPercentEncoding;
                containsEncodedControl |= decoded.DecodedControlCharacter;

                if (!decoded.Changed)
                {
                    current = decoded.Value;
                    break;
                }

                decodePassCount++;
                current = decoded.Value;

                if (ContainsPlainTraversal(current))
                {
                    containsEncodedTraversal = true;
                }
            }

            var overEncodedReserved =
                decodePassCount == MaxPercentDecodePasses &&
                ContainsEncodedReservedCharacter(current);

            return new EncodedPathInspection(
                containsEncodedSeparator,
                containsEncodedTraversal,
                containsMalformed,
                containsEncodedControl,
                overEncodedReserved,
                decodePassCount);
        }

        private static PercentDecodeResult DecodeAsciiPercentTriplets(string value)
        {
            if (string.IsNullOrEmpty(value) || value.IndexOf('%') < 0)
            {
                return new PercentDecodeResult(
                    value ?? string.Empty,
                    changed: false,
                    malformedPercentEncoding: false,
                    decodedSeparator: false,
                    decodedControlCharacter: false);
            }

            var builder = new StringBuilder(value.Length);
            var changed = false;
            var malformed = false;
            var decodedSeparator = false;
            var decodedControl = false;

            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (character != '%')
                {
                    builder.Append(character);
                    continue;
                }

                if (index + 2 >= value.Length ||
                    !TryParseHex(value[index + 1], out var high) ||
                    !TryParseHex(value[index + 2], out var low))
                {
                    malformed = true;
                    builder.Append(character);
                    continue;
                }

                var octet = (high << 4) | low;
                if (octet <= 0x7f)
                {
                    var decodedCharacter = (char)octet;
                    builder.Append(decodedCharacter);
                    changed = true;
                    index += 2;

                    if (decodedCharacter == '/' || decodedCharacter == '\\')
                    {
                        decodedSeparator = true;
                    }

                    if (decodedCharacter < 0x20 || decodedCharacter == 0x7f)
                    {
                        decodedControl = true;
                    }
                    continue;
                }

                // Non-ASCII percent octets are left encoded. Kestrel remains authoritative for
                // UTF-8 path decoding; this inspector only needs ASCII reserved/control bytes to
                // close request-routing ambiguity without reimplementing a URI codec.
                builder.Append('%');
                builder.Append(value[index + 1]);
                builder.Append(value[index + 2]);
                index += 2;
            }

            return new PercentDecodeResult(
                changed ? builder.ToString() : value,
                changed,
                malformed,
                decodedSeparator,
                decodedControl);
        }

        private static bool ContainsEncodedReservedCharacter(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            for (var index = 0; index + 2 < value.Length; index++)
            {
                if (value[index] != '%' ||
                    !TryParseHex(value[index + 1], out var high) ||
                    !TryParseHex(value[index + 2], out var low))
                {
                    continue;
                }

                var octet = (high << 4) | low;
                if (octet == '%' ||
                    octet == '.' ||
                    octet == '/' ||
                    octet == '\\' ||
                    octet < 0x20 ||
                    octet == 0x7f)
                {
                    return true;
                }

                index += 2;
            }

            return false;
        }

        private static bool TryParseHex(char character, out int value)
        {
            if (character >= '0' && character <= '9')
            {
                value = character - '0';
                return true;
            }

            if (character >= 'a' && character <= 'f')
            {
                value = character - 'a' + 10;
                return true;
            }

            if (character >= 'A' && character <= 'F')
            {
                value = character - 'A' + 10;
                return true;
            }

            value = 0;
            return false;
        }

        private readonly struct EncodedPathInspection
        {
            public static EncodedPathInspection Empty { get; } = new EncodedPathInspection(
                containsEncodedSeparator: false,
                containsEncodedTraversal: false,
                containsMalformedPercentEncoding: false,
                containsEncodedControlCharacter: false,
                containsOverEncodedReservedSequence: false,
                percentDecodePassCount: 0);

            public EncodedPathInspection(
                bool containsEncodedSeparator,
                bool containsEncodedTraversal,
                bool containsMalformedPercentEncoding,
                bool containsEncodedControlCharacter,
                bool containsOverEncodedReservedSequence,
                int percentDecodePassCount)
            {
                ContainsEncodedSeparator = containsEncodedSeparator;
                ContainsEncodedTraversal = containsEncodedTraversal;
                ContainsMalformedPercentEncoding = containsMalformedPercentEncoding;
                ContainsEncodedControlCharacter = containsEncodedControlCharacter;
                ContainsOverEncodedReservedSequence = containsOverEncodedReservedSequence;
                PercentDecodePassCount = percentDecodePassCount;
            }

            public bool ContainsEncodedSeparator { get; }

            public bool ContainsEncodedTraversal { get; }

            public bool ContainsMalformedPercentEncoding { get; }

            public bool ContainsEncodedControlCharacter { get; }

            public bool ContainsOverEncodedReservedSequence { get; }

            public int PercentDecodePassCount { get; }
        }

        private readonly struct PercentDecodeResult
        {
            public PercentDecodeResult(
                string value,
                bool changed,
                bool malformedPercentEncoding,
                bool decodedSeparator,
                bool decodedControlCharacter)
            {
                Value = value;
                Changed = changed;
                MalformedPercentEncoding = malformedPercentEncoding;
                DecodedSeparator = decodedSeparator;
                DecodedControlCharacter = decodedControlCharacter;
            }

            public string Value { get; }

            public bool Changed { get; }

            public bool MalformedPercentEncoding { get; }

            public bool DecodedSeparator { get; }

            public bool DecodedControlCharacter { get; }
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
            bool containsMalformedPercentEncoding,
            bool containsEncodedControlCharacter,
            bool containsOverEncodedReservedSequence,
            int percentDecodePassCount)
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
            ContainsMalformedPercentEncoding = containsMalformedPercentEncoding;
            ContainsEncodedControlCharacter = containsEncodedControlCharacter;
            ContainsOverEncodedReservedSequence = containsOverEncodedReservedSequence;
            PercentDecodePassCount = percentDecodePassCount;
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

        public bool ContainsMalformedPercentEncoding { get; }

        public bool ContainsEncodedControlCharacter { get; }

        public bool ContainsOverEncodedReservedSequence { get; }

        public int PercentDecodePassCount { get; }
    }
}
