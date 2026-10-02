using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Diagnostics.Metrics;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleMetricsTests
    {
        private static readonly HashSet<string> AllowedWorkloads = new HashSet<string>(
            new[] { "read", "mutation", "bulk", "health", "unknown" },
            StringComparer.Ordinal);

        private static readonly HashSet<string> AllowedDrainOutcomes = new HashSet<string>(
            new[] { "drained", "deadline" },
            StringComparer.Ordinal);

        [Theory]
        [InlineData(RequestWorkloadClass.InteractiveRead, "read")]
        [InlineData(RequestWorkloadClass.Mutation, "mutation")]
        [InlineData(RequestWorkloadClass.Bulk, "bulk")]
        [InlineData(RequestWorkloadClass.Health, "health")]
        public void NormalizeWorkload_UsesClosedStableVocabulary(
            RequestWorkloadClass workload,
            string expected)
        {
            Assert.Equal(expected, RequestLifecycleMetrics.NormalizeWorkload(workload));
        }

        [Fact]
        public void NormalizeWorkload_UnknownEnumCannotCreateUnboundedTagValue()
        {
            Assert.Equal(
                "unknown",
                RequestLifecycleMetrics.NormalizeWorkload((RequestWorkloadClass)int.MaxValue));
            Assert.Equal(
                "unknown",
                RequestLifecycleMetrics.NormalizeWorkload((RequestWorkloadClass)(-1)));
        }

        [Fact]
        public void DisabledDiagnostics_EmitNoMeasurements()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: false);

            RecordFullRequestLifecycle(metrics, BulkBudget());
            metrics.DrainStarted(7);
            metrics.DrainWaitCompleted(drained: false, TimeSpan.FromSeconds(2));

            Assert.Empty(listener.Measurements);
        }

        [Fact]
        public void EnabledDiagnostics_EmitExpectedRequestInstruments()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);
            var budget = new RequestLifecycleBudget(
                RequestWorkloadClass.Mutation,
                TimeSpan.FromMilliseconds(12_345),
                exemptFromDrain: false);

            metrics.RequestAccepted(budget);
            metrics.RequestRejectedDuringDrain(budget);
            metrics.RequestCompleted(budget);
            metrics.RequestTimedOut(budget);
            metrics.RequestClientCancelled(budget);

            AssertSingleLong(listener, "kentrehberi.lifecycle.request.accepted", 1L, "mutation");
            AssertSingleDouble(listener, "kentrehberi.lifecycle.request.budget", 12_345d, "mutation");
            AssertSingleLong(listener, "kentrehberi.lifecycle.request.rejected", 1L, "mutation");
            AssertSingleLong(listener, "kentrehberi.lifecycle.request.completed", 1L, "mutation");
            AssertSingleLong(listener, "kentrehberi.lifecycle.request.timeout", 1L, "mutation");
            AssertSingleLong(listener, "kentrehberi.lifecycle.request.client_cancelled", 1L, "mutation");
        }

        [Theory]
        [InlineData(RequestWorkloadClass.InteractiveRead, "read")]
        [InlineData(RequestWorkloadClass.Mutation, "mutation")]
        [InlineData(RequestWorkloadClass.Bulk, "bulk")]
        [InlineData(RequestWorkloadClass.Health, "health")]
        public void RequestTags_ContainExactlyOneClosedWorkloadDimension(
            RequestWorkloadClass workload,
            string expected)
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);
            var budget = new RequestLifecycleBudget(
                workload,
                TimeSpan.FromSeconds(1),
                exemptFromDrain: workload == RequestWorkloadClass.Health);

            metrics.RequestAccepted(budget);

            var measurements = listener.ByName("kentrehberi.lifecycle.request.accepted");
            var measurement = Assert.Single(measurements);
            var tag = Assert.Single(measurement.Tags);
            Assert.Equal("kentrehberi.lifecycle.workload", tag.Key);
            Assert.Equal(expected, tag.Value);
            Assert.Contains(expected, AllowedWorkloads);
        }

        [Fact]
        public void InvalidEnumStillEmitsOnlyUnknownClosedWorkloadValue()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);
            var budget = new RequestLifecycleBudget(
                (RequestWorkloadClass)123_456,
                TimeSpan.FromSeconds(1),
                exemptFromDrain: false);

            metrics.RequestAccepted(budget);

            var measurement = Assert.Single(
                listener.ByName("kentrehberi.lifecycle.request.accepted"));
            var tag = Assert.Single(measurement.Tags);
            Assert.Equal("kentrehberi.lifecycle.workload", tag.Key);
            Assert.Equal("unknown", tag.Value);
        }

        [Theory]
        [InlineData(true, "drained")]
        [InlineData(false, "deadline")]
        public void DrainCompletion_UsesClosedOutcomeDimension(bool drained, string expectedOutcome)
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);

            metrics.DrainWaitCompleted(drained, TimeSpan.FromMilliseconds(250));

            var completed = Assert.Single(
                listener.ByName("kentrehberi.lifecycle.drain.completed"));
            var completedTag = Assert.Single(completed.Tags);
            Assert.Equal("kentrehberi.lifecycle.drain.outcome", completedTag.Key);
            Assert.Equal(expectedOutcome, completedTag.Value);
            Assert.Contains(expectedOutcome, AllowedDrainOutcomes);

            var duration = Assert.Single(
                listener.ByName("kentrehberi.lifecycle.drain.duration"));
            var durationTag = Assert.Single(duration.Tags);
            Assert.Equal(expectedOutcome, durationTag.Value);
            Assert.Equal(250d, Assert.IsType<double>(duration.Value));
        }

        [Fact]
        public void DrainStart_HasNoRequestOrIdentityDimensions()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);

            metrics.DrainStarted(9);

            var started = Assert.Single(
                listener.ByName("kentrehberi.lifecycle.drain.started"));
            Assert.Empty(started.Tags);
            Assert.Equal(1L, Assert.IsType<long>(started.Value));

            var initialInFlight = Assert.Single(
                listener.ByName("kentrehberi.lifecycle.drain.initial_inflight"));
            Assert.Empty(initialInFlight.Tags);
            Assert.Equal(9L, Assert.IsType<long>(initialInFlight.Value));
        }

        [Fact]
        public void NegativeDurationsAndCounts_AreClampedBeforeEmission()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);
            var budget = new RequestLifecycleBudget(
                RequestWorkloadClass.InteractiveRead,
                TimeSpan.FromMilliseconds(-250),
                exemptFromDrain: false);

            metrics.RequestAccepted(budget);
            metrics.DrainStarted(-7);
            metrics.DrainWaitCompleted(drained: false, TimeSpan.FromMilliseconds(-99));

            Assert.Equal(
                0d,
                Assert.IsType<double>(Assert.Single(
                    listener.ByName("kentrehberi.lifecycle.request.budget")).Value));
            Assert.Equal(
                0L,
                Assert.IsType<long>(Assert.Single(
                    listener.ByName("kentrehberi.lifecycle.drain.initial_inflight")).Value));
            Assert.Equal(
                0d,
                Assert.IsType<double>(Assert.Single(
                    listener.ByName("kentrehberi.lifecycle.drain.duration")).Value));
        }

        [Fact]
        public void EveryEmittedTagKeyAndValueBelongsToBoundedVocabulary()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);

            foreach (RequestWorkloadClass workload in Enum.GetValues(typeof(RequestWorkloadClass)))
            {
                RecordFullRequestLifecycle(
                    metrics,
                    new RequestLifecycleBudget(
                        workload,
                        TimeSpan.FromSeconds(1),
                        workload == RequestWorkloadClass.Health));
            }
            metrics.DrainStarted(3);
            metrics.DrainWaitCompleted(drained: true, TimeSpan.FromMilliseconds(1));
            metrics.DrainWaitCompleted(drained: false, TimeSpan.FromMilliseconds(2));

            foreach (var measurement in listener.Measurements)
            {
                foreach (var tag in measurement.Tags)
                {
                    Assert.True(
                        tag.Key == "kentrehberi.lifecycle.workload" ||
                        tag.Key == "kentrehberi.lifecycle.drain.outcome");

                    if (tag.Key == "kentrehberi.lifecycle.workload")
                    {
                        Assert.Contains(tag.Value, AllowedWorkloads);
                    }
                    else
                    {
                        Assert.Contains(tag.Value, AllowedDrainOutcomes);
                    }
                }
            }
        }

        [Fact]
        public void InstrumentNamesAndUnitsRemainStableAndBounded()
        {
            using var listener = new LifecycleMeasurementListener();
            using var metrics = CreateMetrics(enabled: true);

            RecordFullRequestLifecycle(metrics, ReadBudget());
            metrics.DrainStarted(1);
            metrics.DrainWaitCompleted(drained: true, TimeSpan.FromMilliseconds(10));

            Assert.All(
                listener.Measurements,
                measurement => Assert.StartsWith(
                    "kentrehberi.lifecycle.",
                    measurement.InstrumentName,
                    StringComparison.Ordinal));

            Assert.Equal(
                "ms",
                listener.SingleUnit("kentrehberi.lifecycle.request.budget"));
            Assert.Equal(
                "ms",
                listener.SingleUnit("kentrehberi.lifecycle.drain.duration"));
        }

        [Fact]
        public void Disposal_IsIdempotentAndPreventsLaterRecording()
        {
            using var listener = new LifecycleMeasurementListener();
            var metrics = CreateMetrics(enabled: true);
            metrics.RequestAccepted(ReadBudget());
            var countBeforeDispose = listener.Measurements.Count;

            metrics.Dispose();
            metrics.Dispose();
            metrics.RequestAccepted(ReadBudget());
            metrics.DrainStarted(1);
            metrics.DrainWaitCompleted(drained: true, TimeSpan.Zero);

            Assert.Equal(countBeforeDispose, listener.Measurements.Count);
        }

        [Fact]
        public void MetricsConstructor_RejectsNullOptions()
        {
            Assert.Throws<ArgumentNullException>(() =>
                new RequestLifecycleMetrics(null!));
        }

        private static RequestLifecycleMetrics CreateMetrics(bool enabled)
        {
            var options = new ApiPlatformOptions();
            options.Diagnostics.Enabled = enabled;
            return new RequestLifecycleMetrics(Options.Create(options));
        }

        private static RequestLifecycleBudget ReadBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.InteractiveRead,
                TimeSpan.FromSeconds(20),
                exemptFromDrain: false);

        private static RequestLifecycleBudget BulkBudget() =>
            new RequestLifecycleBudget(
                RequestWorkloadClass.Bulk,
                TimeSpan.FromSeconds(60),
                exemptFromDrain: false);

        private static void RecordFullRequestLifecycle(
            RequestLifecycleMetrics metrics,
            RequestLifecycleBudget budget)
        {
            metrics.RequestAccepted(budget);
            metrics.RequestRejectedDuringDrain(budget);
            metrics.RequestCompleted(budget);
            metrics.RequestTimedOut(budget);
            metrics.RequestClientCancelled(budget);
        }

        private static void AssertSingleLong(
            LifecycleMeasurementListener listener,
            string instrumentName,
            long expectedValue,
            string expectedWorkload)
        {
            var measurement = Assert.Single(listener.ByName(instrumentName));
            Assert.Equal(expectedValue, Assert.IsType<long>(measurement.Value));
            AssertWorkloadTag(measurement, expectedWorkload);
        }

        private static void AssertSingleDouble(
            LifecycleMeasurementListener listener,
            string instrumentName,
            double expectedValue,
            string expectedWorkload)
        {
            var measurement = Assert.Single(listener.ByName(instrumentName));
            Assert.Equal(expectedValue, Assert.IsType<double>(measurement.Value));
            AssertWorkloadTag(measurement, expectedWorkload);
        }

        private static void AssertWorkloadTag(
            CapturedMeasurement measurement,
            string expectedWorkload)
        {
            var tag = Assert.Single(measurement.Tags);
            Assert.Equal("kentrehberi.lifecycle.workload", tag.Key);
            Assert.Equal(expectedWorkload, tag.Value);
        }

        private sealed class LifecycleMeasurementListener : IDisposable
        {
            private readonly object gate = new object();
            private readonly MeterListener listener;
            private readonly Dictionary<string, string?> units =
                new Dictionary<string, string?>(StringComparer.Ordinal);
            private readonly List<CapturedMeasurement> measurements =
                new List<CapturedMeasurement>();

            public LifecycleMeasurementListener()
            {
                listener = new MeterListener
                {
                    InstrumentPublished = (instrument, meterListener) =>
                    {
                        if (!string.Equals(
                                instrument.Meter.Name,
                                RequestLifecycleMetrics.MeterName,
                                StringComparison.Ordinal))
                        {
                            return;
                        }

                        lock (gate)
                        {
                            units[instrument.Name] = instrument.Unit;
                        }
                        meterListener.EnableMeasurementEvents(instrument);
                    }
                };

                listener.SetMeasurementEventCallback<long>(Capture);
                listener.SetMeasurementEventCallback<double>(Capture);
                listener.Start();
            }

            public IReadOnlyList<CapturedMeasurement> Measurements
            {
                get
                {
                    lock (gate)
                    {
                        return measurements.ToArray();
                    }
                }
            }

            public IReadOnlyList<CapturedMeasurement> ByName(string instrumentName)
            {
                lock (gate)
                {
                    return measurements
                        .Where(value => string.Equals(
                            value.InstrumentName,
                            instrumentName,
                            StringComparison.Ordinal))
                        .ToArray();
                }
            }

            public string? SingleUnit(string instrumentName)
            {
                lock (gate)
                {
                    Assert.True(units.TryGetValue(instrumentName, out var unit));
                    return unit;
                }
            }

            public void Dispose() => listener.Dispose();

            private void Capture(
                Instrument instrument,
                long measurement,
                ReadOnlySpan<KeyValuePair<string, object?>> tags,
                object? state) =>
                CaptureCore(instrument, measurement, tags);

            private void Capture(
                Instrument instrument,
                double measurement,
                ReadOnlySpan<KeyValuePair<string, object?>> tags,
                object? state) =>
                CaptureCore(instrument, measurement, tags);

            private void CaptureCore(
                Instrument instrument,
                object measurement,
                ReadOnlySpan<KeyValuePair<string, object?>> tags)
            {
                var capturedTags = new CapturedTag[tags.Length];
                for (var index = 0; index < tags.Length; index++)
                {
                    capturedTags[index] = new CapturedTag(
                        tags[index].Key,
                        tags[index].Value?.ToString() ?? string.Empty);
                }

                lock (gate)
                {
                    measurements.Add(
                        new CapturedMeasurement(
                            instrument.Name,
                            measurement,
                            capturedTags));
                }
            }
        }

        private sealed class CapturedMeasurement
        {
            public CapturedMeasurement(
                string instrumentName,
                object value,
                IReadOnlyList<CapturedTag> tags)
            {
                InstrumentName = instrumentName;
                Value = value;
                Tags = tags;
            }

            public string InstrumentName { get; }
            public object Value { get; }
            public IReadOnlyList<CapturedTag> Tags { get; }
        }

        private sealed class CapturedTag
        {
            public CapturedTag(string key, string value)
            {
                Key = key;
                Value = value;
            }

            public string Key { get; }
            public string Value { get; }
        }
    }
}
