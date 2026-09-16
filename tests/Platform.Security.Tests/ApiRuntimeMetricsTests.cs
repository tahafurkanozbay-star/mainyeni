using Api.Core.Platform.Diagnostics;
using System;
using System.Collections.Generic;
using System.Diagnostics.Metrics;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class ApiRuntimeMetricsTests
    {
        [Fact]
        public void RequestLifecycle_EmitsBoundedMethodRouteAndStatusTags()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("get", "/api/items/{id}");
            metrics.RequestCompleted(
                "get",
                "/api/items/{id}",
                200,
                durationMs: 12.5,
                requestContentLength: 25,
                responseContentLength: 512);

            Assert.Contains(measurements, item =>
                item.Name == "http.server.active_requests" && item.LongValue == 1);
            Assert.Contains(measurements, item =>
                item.Name == "http.server.active_requests" && item.LongValue == -1);
            Assert.Contains(measurements, item =>
                item.Name == "http.server.request.count" && item.LongValue == 1);
            Assert.Contains(measurements, item =>
                item.Name == "http.server.request.duration" && item.DoubleValue == 12.5d);
            Assert.Contains(measurements, item =>
                item.Name == "http.server.request.body.size" && item.LongValue == 25);
            Assert.Contains(measurements, item =>
                item.Name == "http.server.response.body.size" && item.LongValue == 512);

            var requestCount = measurements.Single(item =>
                item.Name == "http.server.request.count");
            Assert.Equal("GET", requestCount.Tags["http.request.method"]);
            Assert.Equal("/api/items/{id}", requestCount.Tags["http.route"]);
            Assert.Equal(200, requestCount.Tags["http.response.status_code"]);
            Assert.Equal("2xx", requestCount.Tags["http.response.status_class"]);
        }

        [Fact]
        public void RequestLifecycle_MapsUnknownMethodsToOther()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("CUSTOM-VERB", "/api/resource");
            metrics.RequestCompleted("CUSTOM-VERB", "/api/resource", 204, 1, null, null);

            var requestCount = measurements.Single(item =>
                item.Name == "http.server.request.count");
            Assert.Equal("OTHER", requestCount.Tags["http.request.method"]);
        }

        [Fact]
        public void RequestLifecycle_NormalizesEmptyRouteToUnmatched()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("GET", string.Empty);
            metrics.RequestCompleted("GET", string.Empty, 404, 2, null, null);

            var requestCount = measurements.Single(item =>
                item.Name == "http.server.request.count");
            Assert.Equal("unmatched", requestCount.Tags["http.route"]);
        }

        [Fact]
        public void RequestLifecycle_RemovesQueryAndFragmentFromRouteTag()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("GET", "/api/search?q=sensitive#fragment");
            metrics.RequestCompleted("GET", "/api/search?q=sensitive#fragment", 200, 3, null, null);

            var requestCount = measurements.Single(item =>
                item.Name == "http.server.request.count");
            Assert.Equal("/api/search", requestCount.Tags["http.route"]);
            Assert.DoesNotContain("sensitive", requestCount.Tags.Values.OfType<string>());
        }

        [Fact]
        public void RequestLifecycle_BoundsLongRouteTag()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();
            var route = "/api/" + new string('a', 500);

            metrics.RequestStarted("GET", route);
            metrics.RequestCompleted("GET", route, 200, 3, null, null);

            var requestCount = measurements.Single(item =>
                item.Name == "http.server.request.count");
            var normalized = Assert.IsType<string>(requestCount.Tags["http.route"]);
            Assert.Equal(192, normalized.Length);
        }

        [Fact]
        public void RequestCompleted_DoesNotEmitUnknownBodyLengths()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("GET", "/api/data");
            metrics.RequestCompleted("GET", "/api/data", 200, 4, null, null);

            Assert.DoesNotContain(measurements, item =>
                item.Name == "http.server.request.body.size");
            Assert.DoesNotContain(measurements, item =>
                item.Name == "http.server.response.body.size");
        }

        [Fact]
        public void RequestCompleted_ClampsNegativeDurationToZero()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("GET", "/api/data");
            metrics.RequestCompleted("GET", "/api/data", 200, -100, null, null);

            var duration = measurements.Single(item =>
                item.Name == "http.server.request.duration");
            Assert.Equal(0d, duration.DoubleValue);
        }

        [Theory]
        [InlineData(100, "1xx")]
        [InlineData(204, "2xx")]
        [InlineData(302, "3xx")]
        [InlineData(404, "4xx")]
        [InlineData(503, "5xx")]
        public void RequestCompleted_EmitsStatusClass(int status, string expectedClass)
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestStarted("GET", "/api/status");
            metrics.RequestCompleted("GET", "/api/status", status, 1, null, null);

            var request = measurements.Single(item => item.Name == "http.server.request.count");
            Assert.Equal(expectedClass, request.Tags["http.response.status_class"]);
        }

        [Fact]
        public void RequestFailed_EmitsOnlyExceptionTypeNotMessage()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();
            var error = new InvalidOperationException("database-password-should-not-leak");

            metrics.RequestFailed("POST", "/api/data", 500, error);

            var failure = measurements.Single(item =>
                item.Name == "http.server.exception.count");
            Assert.Equal("InvalidOperationException", failure.Tags["error.type"]);
            Assert.DoesNotContain(
                failure.Tags.Values.OfType<string>(),
                value => value.Contains("database-password", StringComparison.Ordinal));
        }

        [Fact]
        public void RequestCancelled_EmitsCancellationCounter()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RequestCancelled("GET", "/api/slow");

            var cancellation = measurements.Single(item =>
                item.Name == "http.server.cancellation.count");
            Assert.Equal(1L, cancellation.LongValue);
            Assert.Equal(499, cancellation.Tags["http.response.status_code"]);
            Assert.Equal("4xx", cancellation.Tags["http.response.status_class"]);
        }

        [Fact]
        public void RateLimitRejected_EmitsRateLimitCounter()
        {
            var measurements = new List<MeasurementRecord>();
            using var listener = CreateListener(measurements);
            using var metrics = new ApiRuntimeMetrics();

            metrics.RateLimitRejected("GET", "/api/search");

            var rejection = measurements.Single(item =>
                item.Name == "http.server.rate_limit.rejection.count");
            Assert.Equal(1L, rejection.LongValue);
            Assert.Equal(429, rejection.Tags["http.response.status_code"]);
        }

        [Fact]
        public void Dispose_IsIdempotent()
        {
            var metrics = new ApiRuntimeMetrics();

            metrics.Dispose();
            metrics.Dispose();
        }

        [Fact]
        public void RecordingAfterDispose_FailsFast()
        {
            var metrics = new ApiRuntimeMetrics();
            metrics.Dispose();

            Assert.Throws<ObjectDisposedException>(() =>
                metrics.RequestStarted("GET", "/api/data"));
        }

        private static MeterListener CreateListener(ICollection<MeasurementRecord> measurements)
        {
            var listener = new MeterListener();
            listener.InstrumentPublished = (instrument, meterListener) =>
            {
                if (instrument.Meter.Name == ApiRuntimeMetrics.MeterName)
                {
                    meterListener.EnableMeasurementEvents(instrument);
                }
            };

            listener.SetMeasurementEventCallback<long>((instrument, measurement, tags, state) =>
            {
                measurements.Add(new MeasurementRecord(
                    instrument.Name,
                    longValue: measurement,
                    doubleValue: null,
                    CopyTags(tags)));
            });
            listener.SetMeasurementEventCallback<double>((instrument, measurement, tags, state) =>
            {
                measurements.Add(new MeasurementRecord(
                    instrument.Name,
                    longValue: null,
                    doubleValue: measurement,
                    CopyTags(tags)));
            });
            listener.Start();
            return listener;
        }

        private static Dictionary<string, object?> CopyTags(
            ReadOnlySpan<KeyValuePair<string, object?>> tags)
        {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var tag in tags)
            {
                result[tag.Key] = tag.Value;
            }
            return result;
        }

        private sealed record MeasurementRecord(
            string Name,
            long? LongValue,
            double? DoubleValue,
            Dictionary<string, object?> Tags);
    }
}
