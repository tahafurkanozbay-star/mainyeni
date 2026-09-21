using Api.Core.Platform.Diagnostics;
using System;
using System.Collections.Generic;
using System.Diagnostics.Metrics;
using System.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ApiGovernanceMetricsTests
{
    [Fact]
    public void GovernanceRejected_EmitsLowCardinalityPolicyCode()
    {
        var measurements = new List<MetricRecord>();
        using var listener = CreateListener(measurements);
        using var metrics = new ApiRuntimeMetrics();

        metrics.GovernanceRejected(
            "POST",
            "/api/items/{id}",
            431,
            "headers-too-large");

        var measurement = Assert.Single(measurements.Where(
            item => item.Name == "http.server.governance.rejection.count"));
        Assert.Equal(1L, measurement.Value);
        Assert.Equal("POST", measurement.Tags["http.request.method"]);
        Assert.Equal("/api/items/{id}", measurement.Tags["http.route"]);
        Assert.Equal(431, measurement.Tags["http.response.status_code"]);
        Assert.Equal("4xx", measurement.Tags["http.response.status_class"]);
        Assert.Equal("headers-too-large", measurement.Tags["kentrehberi.governance.policy"]);
    }

    [Fact]
    public void GovernanceRejected_DropsUnsafePolicyCharacters()
    {
        var measurements = new List<MetricRecord>();
        using var listener = CreateListener(measurements);
        using var metrics = new ApiRuntimeMetrics();

        metrics.GovernanceRejected(
            "GET",
            "/api/items",
            400,
            "path\r\nsecret:value");

        var measurement = Assert.Single(measurements.Where(
            item => item.Name == "http.server.governance.rejection.count"));
        var code = Assert.IsType<string>(
            measurement.Tags["kentrehberi.governance.policy"]);

        Assert.DoesNotContain("\r", code, StringComparison.Ordinal);
        Assert.DoesNotContain("\n", code, StringComparison.Ordinal);
        Assert.DoesNotContain(":", code, StringComparison.Ordinal);
        Assert.Equal("pathsecretvalue", code);
    }

    [Fact]
    public void GovernanceRejected_MapsBlankPolicyToUnknown()
    {
        var measurements = new List<MetricRecord>();
        using var listener = CreateListener(measurements);
        using var metrics = new ApiRuntimeMetrics();

        metrics.GovernanceRejected("GET", "unmatched", 503, "   ");

        var measurement = Assert.Single(measurements.Where(
            item => item.Name == "http.server.governance.rejection.count"));
        Assert.Equal("unknown", measurement.Tags["kentrehberi.governance.policy"]);
    }

    [Fact]
    public void GovernanceRejected_BoundsPolicyCodeLength()
    {
        var measurements = new List<MetricRecord>();
        using var listener = CreateListener(measurements);
        using var metrics = new ApiRuntimeMetrics();

        metrics.GovernanceRejected(
            "GET",
            "/api/items",
            503,
            new string('a', 200));

        var measurement = Assert.Single(measurements.Where(
            item => item.Name == "http.server.governance.rejection.count"));
        var code = Assert.IsType<string>(
            measurement.Tags["kentrehberi.governance.policy"]);
        Assert.Equal(64, code.Length);
    }

    private static MeterListener CreateListener(ICollection<MetricRecord> records)
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
            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var tag in tags)
            {
                copied[tag.Key] = tag.Value;
            }

            records.Add(new MetricRecord(instrument.Name, measurement, copied));
        });
        listener.Start();
        return listener;
    }

    private sealed record MetricRecord(
        string Name,
        long Value,
        Dictionary<string, object?> Tags);
}
