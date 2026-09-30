using Microsoft.Extensions.Primitives;
using System;
using System.Globalization;

namespace Api.Core.Platform.Governance
{
    /// <summary>Fail-closed validation for HTTP message framing metadata.</summary>
    public static class RequestFramingPolicy
    {
        public static RequestFramingValidation ValidateContentLength(StringValues values)
        {
            if (values.Count == 0) return RequestFramingValidation.Valid();
            if (values.Count != 1) return RequestFramingValidation.Invalid("multiple-content-length");

            var value = values[0];
            if (string.IsNullOrWhiteSpace(value))
                return RequestFramingValidation.Invalid("invalid-content-length");
            if (value.IndexOf(',', StringComparison.Ordinal) >= 0)
                return RequestFramingValidation.Invalid("invalid-content-length");
            if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var length) || length < 0)
                return RequestFramingValidation.Invalid("invalid-content-length");

            return RequestFramingValidation.Valid();
        }

        public static RequestFramingValidation ValidateTransferEncoding(StringValues values)
        {
            if (values.Count == 0) return RequestFramingValidation.Valid();
            if (values.Count != 1) return RequestFramingValidation.Invalid("multiple-transfer-encoding");

            var value = values[0];
            if (string.IsNullOrWhiteSpace(value))
                return RequestFramingValidation.Invalid("unsupported-transfer-encoding");
            if (value.IndexOf(',', StringComparison.Ordinal) >= 0)
                return RequestFramingValidation.Invalid("unsupported-transfer-encoding");
            if (!string.Equals(value.Trim(), "chunked", StringComparison.OrdinalIgnoreCase))
                return RequestFramingValidation.Invalid("unsupported-transfer-encoding");

            return RequestFramingValidation.Valid();
        }
    }

    public readonly struct RequestFramingValidation
    {
        private RequestFramingValidation(bool isValid, string code)
        {
            IsValid = isValid;
            Code = code ?? string.Empty;
        }

        public bool IsValid { get; }
        public string Code { get; }

        public static RequestFramingValidation Valid() => new(true, string.Empty);
        public static RequestFramingValidation Invalid(string code) => new(false, code);
    }
}
