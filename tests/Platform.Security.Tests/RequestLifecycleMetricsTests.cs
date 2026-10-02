using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics.Metrics;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleMetricsTests
    {
        private static readonly RequestLifecycleBudget Read = new RequestLifecycleBudget(RequestWorkloadClass.InteractiveRead, TimeSpan.FromSeconds(20), false);
        private static readonly RequestLifecycleBudget Mutation = new RequestLifecycleBudget(RequestWorkloadClass.Mutation, TimeSpan.FromSeconds(30), false);
        private static readonly RequestLifecycleBudget Bulk = new RequestLifecycleBudget(RequestWorkloadClass.Bulk, TimeSpan.FromSeconds(60), false);
        private static readonly RequestLifecycleBudget Health = new RequestLifecycleBudget(RequestWorkloadClass.Health, TimeSpan.FromSeconds(5), true);

        [Fact]
        public void EnabledMetrics_ExposeOnlyClosedWorkloadTags()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);

            metrics.RequestAccepted(Read);
            metrics.RequestAccepted(Mutation);
            metrics.RequestAccepted(Bulk);
            metrics.RequestAccepted(Health);

            var accepted = capture.LongMeasurements("kentrehberi.lifecycle.request.accepted");
            Assert.Equal(4, accepted.Count);
            Assert.Equal(new[] { "bulk", "health", "mutation", "read" },
                accepted.Select(item => item.Tag("kentrehberi.lifecycle.workload")).OrderBy(value => value).ToArray());
            Assert.All(accepted, item => Assert.Single(item.Tags));
        }

        [Fact]
        public void RequestBudget_RecordsConfiguredBoundedDurations()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);

            metrics.RequestAccepted(Read);
            metrics.RequestAccepted(Mutation);
            metrics.RequestAccepted(Bulk);
            metrics.RequestAccepted(Health);

            var budgets = capture.DoubleMeasurements("kentrehberi.lifecycle.request.budget");
            Assert.Equal(4, budgets.Count);
            Assert.Contains(budgets, item => item.Value == 20_000d && item.Tag("kentrehberi.lifecycle.workload") == "read");
            Assert.Contains(budgets, item => item.Value == 30_000d && item.Tag("kentrehberi.lifecycle.workload") == "mutation");
            Assert.Contains(budgets, item => item.Value == 60_000d && item.Tag("kentrehberi.lifecycle.workload") == "bulk");
            Assert.Contains(budgets, item => item.Value == 5_000d && item.Tag("kentrehberi.lifecycle.workload") == "health");
        }

        [Fact]
        public void RequestOutcomes_NeverEmitPathIdentityOrArbitraryPayloadTags()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);

            metrics.RequestRejectedDuringDrain(Read);
            metrics.RequestCompleted(Mutation);
            metrics.RequestTimedOut(Bulk);
            metrics.RequestClientCancelled(Health);

            var names = new[]
            {
                "kentrehberi.lifecycle.request.rejected",
                "kentrehberi.lifecycle.request.completed",
                "kentrehberi.lifecycle.request.timeout",
                "kentrehberi.lifecycle.request.client_cancelled"
            };

            foreach (var name in names)
            {
                var measurement = Assert.Single(capture.LongMeasurements(name));
                var tag = Assert.Single(measurement.Tags);
                Assert.Equal("kentrehberi.lifecycle.workload", tag.Key);
                Assert.Contains(tag.Value, new[] { "read", "mutation", "bulk", "health" });
            }
        }

        [Fact]
        public void DrainMetrics_UseClosedOutcomeAndAggregateValuesOnly()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);

            metrics.DrainStarted(7);
            metrics.DrainWaitCompleted(true, TimeSpan.FromMilliseconds(125));
            metrics.DrainWaitCompleted(false, TimeSpan.FromMilliseconds(250));

            Assert.Equal(1L, Assert.Single(capture.LongMeasurements("kentrehberi.lifecycle.drain.started")).Value);
            Assert.Equal(7L, Assert.Single(capture.LongMeasurements("kentrehberi.lifecycle.drain.initial_inflight")).Value);

            var completions = capture.LongMeasurements("kentrehberi.lifecycle.drain.completed");
            Assert.Equal(2, completions.Count);
            Assert.Contains(completions, item => item.Tag("kentrehberi.lifecycle.drain.outcome") == "drained");
            Assert.Contains(completions, item => item.Tag("kentrehberi.lifecycle.drain.outcome") == "deadline");
            Assert.All(completions, item => Assert.Single(item.Tags));

            var durations = capture.DoubleMeasurements("kentrehberi.lifecycle.drain.duration");
            Assert.Contains(durations, item => item.Value == 125d && item.Tag("kentrehberi.lifecycle.drain.outcome") == "drained");
            Assert.Contains(durations, item => item.Value == 250d && item.Tag("kentrehberi.lifecycle.drain.outcome") == "deadline");
        }

        [Fact]
        public void NegativeAggregateInputs_AreClampedBeforeEmission()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);

            metrics.DrainStarted(-42);
            metrics.DrainWaitCompleted(false, TimeSpan.FromMilliseconds(-50));

            Assert.Equal(0L, Assert.Single(capture.LongMeasurements("kentrehberi.lifecycle.drain.initial_inflight")).Value);
            Assert.Equal(0d, Assert.Single(capture.DoubleMeasurements("kentrehberi.lifecycle.drain.duration")).Value);
        }

        [Fact]
        public void DisabledDiagnostics_ProduceNoMeasurements()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(false);

            metrics.RequestAccepted(Read);
            metrics.RequestRejectedDuringDrain(Mutation);
            metrics.RequestCompleted(Bulk);
            metrics.RequestTimedOut(Read);
            metrics.RequestClientCancelled(Read);
            metrics.DrainStarted(5);
            metrics.DrainWaitCompleted(true, TimeSpan.FromMilliseconds(10));

            Assert.Empty(capture.All);
        }

        [Fact]
        public void Dispose_IsIdempotentAndSuppressesFurtherRecording()
        {
            using var capture = new MetricCapture();
            var metrics = CreateMetrics(true);
            metrics.RequestAccepted(Read);
            var before = capture.All.Count;

            metrics.Dispose();
            metrics.Dispose();
            metrics.RequestAccepted(Read);
            metrics.DrainStarted(1);

            Assert.Equal(before, capture.All.Count);
        }

        [Theory]
        [InlineData(RequestWorkloadClass.InteractiveRead, "read")]
        [InlineData(RequestWorkloadClass.Mutation, "mutation")]
        [InlineData(RequestWorkloadClass.Bulk, "bulk")]
        [InlineData(RequestWorkloadClass.Health, "health")]
        [InlineData((RequestWorkloadClass)999, "unknown")]
        public void WorkloadNormalization_IsClosedAndDeterministic(RequestWorkloadClass workload, string expected)
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);
            var budget = new RequestLifecycleBudget(workload, TimeSpan.FromSeconds(1), false);

            metrics.RequestAccepted(budget);

            var measurement = Assert.Single(capture.LongMeasurements("kentrehberi.lifecycle.request.accepted"));
            Assert.Equal(expected, measurement.Tag("kentrehberi.lifecycle.workload"));
        }

        [Fact]
        public void InstrumentSurface_IsStableAndBounded()
        {
            using var capture = new MetricCapture();
            using var metrics = CreateMetrics(true);
            metrics.RequestAccepted(Read);
            metrics.RequestRejectedDuringDrain(Read);
            metrics.RequestCompleted(Read);
            metrics.RequestTimedOut(Read);
            metrics.RequestClientCancelled(Read);
            metrics.DrainStarted(1);
            metrics.DrainWaitCompleted(true, TimeSpan.FromMilliseconds(1));

            var expected = new[]
            {
                "kentrehberi.lifecycle.drain.completed",
                "kentrehberi.lifecycle.drain.duration",
                "kentrehberi.lifecycle.drain.initial_inflight",
                "kentrehberi.lifecycle.drain.started",
                "kentrehberi.lifecycle.request.accepted",
                "kentrehberi.lifecycle.request.budget",
                "kentrehberi.lifecycle.request.client_cancelled",
                "kentrehberi.lifecycle.request.completed",
                "kentrehberi.lifecycle.request.rejected",
                "kentrehberi.lifecycle.request.timeout"
            };

            Assert.Equal(expected, capture.All.Select(item => item.Name).Distinct().OrderBy(name => name).ToArray());
        }

        private static RequestLifecycleMetrics CreateMetrics(bool enabled)
        {
            var options = new ApiPlatformOptions();
            options.Diagnostics.Enabled = enabled;
            return new RequestLifecycleMetrics(Options.Create(options));
        }

        private sealed class MetricCapture : IDisposable
        {
            private readonly MeterListener listener;
            private readonly ConcurrentQueue<CapturedMeasurement> measurements = new ConcurrentQueue<CapturedMeasurement>();

            public MetricCapture()
            {
                listener = new MeterListener();
                listener.InstrumentPublished = (instrument, activeListener) =>
                {
                    if (instrument.Meter.Name == RequestLifecycleMetrics.MeterName)
                    {
                        activeListener.EnableMeasurementEvents(instrument);
                    }
                };
                listener.SetMeasurementEventCallback<long>((instrument, value, tags, state) =>
                    measurements.Enqueue(new CapturedMeasurement(instrument.Name, value, CopyTags(tags))));
                listener.SetMeasurementEventCallback<double>((instrument, value, tags, state) =>
                    measurements.Enqueue(new CapturedMeasurement(instrument.Name, value, CopyTags(tags))));
                listener.Start();
            }

            public IReadOnlyList<CapturedMeasurement> All => measurements.ToArray();

            public IReadOnlyList<CapturedMeasurement> LongMeasurements(string name) =>
                All.Where(item => item.Name == name && item.Value is long).ToArray();

            public IReadOnlyList<CapturedMeasurement> DoubleMeasurements(string name) =>
                All.Where(item => item.Name == name && item.Value is double).ToArray();

            public void Dispose() => listener.Dispose();

            private static IReadOnlyList<KeyValuePair<string, object>> CopyTags(ReadOnlySpan<KeyValuePair<string, object>> tags)
            {
                var copy = new KeyValuePair<string, object>[tags.Length];
                for (var index = 0; index < tags.Length; index++) copy[index] = tags[index];
                return copy;
            }
        }

        private sealed class CapturedMeasurement
        {
            public CapturedMeasurement(string name, object value, IReadOnlyList<KeyValuePair<string, object>> tags)
            {
                Name = name;
                Value = value;
                Tags = tags;
            }

            public string Name { get; }
            public object Value { get; }
            public IReadOnlyList<KeyValuePair<string, object>> Tags { get; }

            public string Tag(string key)
            {
                var match = Tags.Single(pair => pair.Key == key);
                return match.Value?.ToString();
            }
        }
    }
}
