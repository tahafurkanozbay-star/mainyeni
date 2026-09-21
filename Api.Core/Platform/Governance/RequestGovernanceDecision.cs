using Microsoft.AspNetCore.Http;
using System;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Immutable result produced by the request-governance preflight. The object intentionally
    /// contains only low-cardinality policy facts; request values, credentials, query strings and
    /// client identifiers are never carried into diagnostics or response payloads.
    /// </summary>
    public sealed class RequestGovernanceDecision
    {
        private RequestGovernanceDecision(
            bool allowed,
            int statusCode,
            string code,
            string title,
            string detail,
            int? retryAfterSeconds)
        {
            Allowed = allowed;
            StatusCode = statusCode;
            Code = code ?? string.Empty;
            Title = title ?? string.Empty;
            Detail = detail ?? string.Empty;
            RetryAfterSeconds = retryAfterSeconds;
        }

        public bool Allowed { get; }

        public int StatusCode { get; }

        public string Code { get; }

        public string Title { get; }

        public string Detail { get; }

        public int? RetryAfterSeconds { get; }

        public static RequestGovernanceDecision Allow()
        {
            return new RequestGovernanceDecision(
                allowed: true,
                statusCode: StatusCodes.Status200OK,
                code: "allowed",
                title: string.Empty,
                detail: string.Empty,
                retryAfterSeconds: null);
        }

        public static RequestGovernanceDecision Reject(
            int statusCode,
            string code,
            string title,
            string detail,
            int? retryAfterSeconds = null)
        {
            if (statusCode < 400 || statusCode > 599)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(statusCode),
                    statusCode,
                    "Governance rejections must use a 4xx or 5xx HTTP status.");
            }

            var normalizedCode = NormalizeCode(code);
            if (string.IsNullOrWhiteSpace(normalizedCode))
            {
                throw new ArgumentException("A governance rejection code is required.", nameof(code));
            }

            return new RequestGovernanceDecision(
                allowed: false,
                statusCode: statusCode,
                code: normalizedCode,
                title: string.IsNullOrWhiteSpace(title) ? "Request rejected" : title.Trim(),
                detail: string.IsNullOrWhiteSpace(detail)
                    ? "The request violates an API runtime policy."
                    : detail.Trim(),
                retryAfterSeconds: retryAfterSeconds.HasValue
                    ? Math.Clamp(retryAfterSeconds.Value, 1, 3600)
                    : null);
        }

        public override string ToString()
        {
            return Allowed
                ? "allowed"
                : $"{Code}:{StatusCode}";
        }

        private static string NormalizeCode(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            var source = value.Trim();
            var buffer = new char[Math.Min(source.Length, 64)];
            var length = 0;

            foreach (var character in source)
            {
                if (length >= buffer.Length)
                {
                    break;
                }

                if (char.IsAsciiLetterOrDigit(character) ||
                    character == '-' ||
                    character == '_' ||
                    character == '.')
                {
                    buffer[length++] = char.ToLowerInvariant(character);
                }
                else if (length > 0 && buffer[length - 1] != '-')
                {
                    buffer[length++] = '-';
                }
            }

            while (length > 0 && buffer[length - 1] == '-')
            {
                length--;
            }

            return new string(buffer, 0, length);
        }
    }
}
