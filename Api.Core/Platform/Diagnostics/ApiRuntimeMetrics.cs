using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;

namespace Api.Core.Platform.Diagnostics
{
    /// <summary>
    /// Low-cardinality runtime metrics for the shared API platform. The implementation uses the
    /// BCL Meter API only, so deployments can attach OpenTelemetry, EventCounters, or another
    /// listener without coupling application code to a specific telemetry vendor.
    /// </summary>
    public sealed class ApiRuntimeMetrics : IDisposable
    {
        public const string MeterName = "KentRehberi.Api";
        public const string MeterVersion = "1.0.0";

        private static readonly HashSet<string> KnownMethods = new HashSet<string>(
            new[] { "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS" },
            StringComparer.OrdinalIgnoreCase);

        private readonly Meter meter;
        private readonly Counter<long> requestCounter;
        private readonly UpDownCounter<long> activeRequestCounter;
        private readonly Histogram<double> requestDuration;
        private readonly Histogram<long> requestBodySize;
        private readonly Histogram<long> responseBodySize;
        private readonly Counter<long> exceptionCounter;
        private readonly Counter<long> cancellationCounter;
        private readonly Counter<long> rateLimitCounter;
        private readonly Counter<long> governanceRejectionCounter;
        private bool disposed;

        public ApiRuntimeMetrics()
        {
            meter = new Meter(MeterName, MeterVersion);
            requestCounter = meter.CreateCounter<long>(
                "http.server.request.count",
                unit: "{request}",
                description: "Completed Kent Rehberi API requests.");
            activeRequestCounter = meter.CreateUpDownCounter<long>(
                "http.server.active_requests",
                unit: "{request}",
                description: "Requests currently executing in the Kent Rehberi API pipeline.");
            requestDuration = meter.CreateHistogram<double>(
                "http.server.request.duration",
                unit: "ms",
                description: "Server-side request duration in milliseconds.");
            requestBodySize = meter.CreateHistogram<long>(
                "http.server.request.body.size",
                unit: "By",
                description: "Declared HTTP request body size when available.");
            responseBodySize = meter.CreateHistogram<long>(
                "http.server.response.body.size",
                unit: "By",
                description: "Declared HTTP response body size when available.");
            exceptionCounter = meter.CreateCounter<long>(
                "http.server.exception.count",
                unit: "{exception}",
                description: "Unhandled exceptions observed by the request metrics middleware.");
            cancellationCounter = meter.CreateCounter<long>(
                "http.server.cancellation.count",
                unit: "{request}",
                description: "Requests cancelled by the connected client or server request token.");
            rateLimitCounter = meter.CreateCounter<long>(
                "http.server.rate_limit.rejection.count",
                unit: "{request}",
                description: "Requests rejected by the server-side rate limiter.");
            governanceRejectionCounter = meter.CreateCounter<long>(
                "http.server.governance.rejection.count",
                unit: "{request}",
                description: "Requests rejected by bounded API metadata or concurrency governance.");
        }

        public void RequestStarted(string method, string route)
        {
            ThrowIfDisposed();
            activeRequestCounter.Add(1, BuildTags(method, route, statusCode: null));
        }

        public void RequestCompleted(
            string method,
            string route,
            int statusCode,
            double durationMs,
            long? requestContentLength,
            long? responseContentLength)
        {
            ThrowIfDisposed();
            var tags = BuildTags(method, route, statusCode);
            activeRequestCounter.Add(-1, tags);
            requestCounter.Add(1, tags);
            requestDuration.Record(Math.Max(0d, durationMs), tags);

            if (requestContentLength >= 0)
            {
                requestBodySize.Record(requestContentLength.Value, tags);
            }

            if (responseContentLength >= 0)
            {
                responseBodySize.Record(responseContentLength.Value, tags);
            }
        }

        public void RequestFailed(
            string method,
            string route,
            int statusCode,
            Exception exception)
        {
            ThrowIfDisposed();
            var tags = BuildTags(method, route, statusCode);
            tags.Add("error.type", NormalizeExceptionType(exception));
            exceptionCounter.Add(1, tags);
        }

        public void RequestCancelled(string method, string route)
        {
            ThrowIfDisposed();
            cancellationCounter.Add(1, BuildTags(method, route, statusCode: 499));
        }

        public void RateLimitRejected(string method, string route)
        {
            ThrowIfDisposed();
            rateLimitCounter.Add(1, BuildTags(method, route, StatusCodes.Status429TooManyRequests));
        }

        public void GovernanceRejected(
            string method,
            string route,
            int statusCode,
            string policyCode)
        {
            ThrowIfDisposed();
            var tags = BuildTags(method, route, statusCode);
            tags.Add("kentrehberi.governance.policy", NormalizePolicyCode(policyCode));
            governanceRejectionCounter.Add(1, tags);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            meter.Dispose();
        }

        internal static TagList BuildTags(
            string method,
            string route,
            int? statusCode)
        {
            var tags = new TagList
            {
                { "http.request.method", NormalizeMethod(method) },
                { "http.route", NormalizeRoute(route) }
            };

            if (statusCode.HasValue)
            {
                var status = Math.Clamp(statusCode.Value, 100, 599);
                tags.Add("http.response.status_code", status);
                tags.Add("http.response.status_class", (status / 100).ToString(CultureInfo.InvariantCulture) + "xx");
            }

            return tags;
        }

        internal static string NormalizeMethod(string method)
        {
            var normalized = string.IsNullOrWhiteSpace(method)
                ? "UNKNOWN"
                : method.Trim().ToUpperInvariant();

            return KnownMethods.Contains(normalized) ? normalized : "OTHER";
        }

        internal static string NormalizeRoute(string route)
        {
            if (string.IsNullOrWhiteSpace(route))
            {
                return "unmatched";
            }

            var value = route.Trim();
            var queryIndex = value.IndexOfAny(new[] { '?', '#' });
            if (queryIndex >= 0)
            {
                value = value.Substring(0, queryIndex);
            }

            if (!value.StartsWith("/", StringComparison.Ordinal))
            {
                value = "/" + value;
            }

            if (value.Length > 192)
            {
                value = value.Substring(0, 192);
            }

            return value;
        }

        internal static string NormalizePolicyCode(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "unknown";
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
            }

            return length == 0
                ? "unknown"
                : new string(buffer, 0, length);
        }

        private static string NormalizeExceptionType(Exception exception)
        {
            if (exception == null)
            {
                return "unknown";
            }

            var name = exception.GetType().Name;
            return name.Length <= 96 ? name : name.Substring(0, 96);
        }

        private void ThrowIfDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException(nameof(ApiRuntimeMetrics));
            }
        }
    }
}
