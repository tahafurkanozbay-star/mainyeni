using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Threading;

namespace Api.User.KentRehberi;

public sealed record KentRehberiRuntimeSnapshot(
    long RequestsStarted,
    long RequestsCompleted,
    long RequestsFailed,
    long CacheHits,
    long CacheMisses,
    long CacheEvictions,
    long SingleFlightJoins,
    long AdmissionRejected,
    long DeadlineExceeded,
    long IntegrityRejected,
    int ActiveQueries,
    int QueuedQueries);

public sealed class KentRehberiTelemetry : IDisposable
{
    public const string MeterName = "Ankara.KentRehberi.Data";
    public const string ActivitySourceName = "Ankara.KentRehberi.Data";

    private readonly Meter meter = new(MeterName, "1.0.0");
    private readonly ActivitySource activitySource =
        new(ActivitySourceName, "1.0.0");

    private readonly Counter<long> requestCounter;
    private readonly Counter<long> failureCounter;
    private readonly Counter<long> cacheHitCounter;
    private readonly Counter<long> cacheMissCounter;
    private readonly Counter<long> cacheEvictionCounter;
    private readonly Counter<long> singleFlightJoinCounter;
    private readonly Counter<long> admissionRejectedCounter;
    private readonly Counter<long> deadlineExceededCounter;
    private readonly Counter<long> integrityRejectedCounter;
    private readonly Histogram<double> durationHistogram;
    private readonly Histogram<long> responseBytesHistogram;
    private readonly Histogram<long> responseFeaturesHistogram;

    private long requestsStarted;
    private long requestsCompleted;
    private long requestsFailed;
    private long cacheHits;
    private long cacheMisses;
    private long cacheEvictions;
    private long singleFlightJoins;
    private long admissionRejected;
    private long deadlineExceeded;
    private long integrityRejected;
    private int activeQueries;
    private int queuedQueries;

    public KentRehberiTelemetry()
    {
        requestCounter = meter.CreateCounter<long>(
            "kent_rehberi.requests");
        failureCounter = meter.CreateCounter<long>(
            "kent_rehberi.failures");
        cacheHitCounter = meter.CreateCounter<long>(
            "kent_rehberi.cache.hits");
        cacheMissCounter = meter.CreateCounter<long>(
            "kent_rehberi.cache.misses");
        cacheEvictionCounter = meter.CreateCounter<long>(
            "kent_rehberi.cache.evictions");
        singleFlightJoinCounter = meter.CreateCounter<long>(
            "kent_rehberi.singleflight.joins");
        admissionRejectedCounter = meter.CreateCounter<long>(
            "kent_rehberi.admission.rejected");
        deadlineExceededCounter = meter.CreateCounter<long>(
            "kent_rehberi.deadline.exceeded");
        integrityRejectedCounter = meter.CreateCounter<long>(
            "kent_rehberi.integrity.rejected");

        durationHistogram = meter.CreateHistogram<double>(
            "kent_rehberi.duration",
            "ms");
        responseBytesHistogram = meter.CreateHistogram<long>(
            "kent_rehberi.response.bytes",
            "By");
        responseFeaturesHistogram = meter.CreateHistogram<long>(
            "kent_rehberi.response.features",
            "{feature}");

        meter.CreateObservableGauge(
            "kent_rehberi.active_queries",
            () => Volatile.Read(ref activeQueries),
            "{query}");
        meter.CreateObservableGauge(
            "kent_rehberi.queued_queries",
            () => Volatile.Read(ref queuedQueries),
            "{query}");
    }

    public Activity? StartActivity(string operation)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(operation);

        return activitySource.StartActivity(
            "kent-rehberi." + operation,
            ActivityKind.Internal);
    }

    public void RequestStarted(string operation)
    {
        Interlocked.Increment(ref requestsStarted);
        Interlocked.Increment(ref activeQueries);
        requestCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void RequestCompleted(
        string operation,
        TimeSpan duration,
        long responseBytes,
        int featureCount)
    {
        Interlocked.Increment(ref requestsCompleted);
        DecrementActive();

        durationHistogram.Record(
            Math.Max(0d, duration.TotalMilliseconds),
            new KeyValuePair<string, object?>(
                "operation",
                operation));
        responseBytesHistogram.Record(
            Math.Max(0L, responseBytes),
            new KeyValuePair<string, object?>(
                "operation",
                operation));
        responseFeaturesHistogram.Record(
            Math.Max(0, featureCount),
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void RequestFailed(
        string operation,
        string failureKind,
        TimeSpan duration)
    {
        Interlocked.Increment(ref requestsFailed);
        DecrementActive();

        failureCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation),
            new KeyValuePair<string, object?>(
                "failure.kind",
                failureKind));

        durationHistogram.Record(
            Math.Max(0d, duration.TotalMilliseconds),
            new KeyValuePair<string, object?>(
                "operation",
                operation),
            new KeyValuePair<string, object?>(
                "outcome",
                "failure"));
    }

    public void CacheHit(string operation)
    {
        Interlocked.Increment(ref cacheHits);
        cacheHitCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void CacheMiss(string operation)
    {
        Interlocked.Increment(ref cacheMisses);
        cacheMissCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void CacheEvicted(string reason)
    {
        Interlocked.Increment(ref cacheEvictions);
        cacheEvictionCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "reason",
                reason));
    }

    public void SingleFlightJoined(string operation)
    {
        Interlocked.Increment(ref singleFlightJoins);
        singleFlightJoinCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void AdmissionRejected(string operation)
    {
        Interlocked.Increment(ref admissionRejected);
        admissionRejectedCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void DeadlineExceeded(string operation)
    {
        Interlocked.Increment(ref deadlineExceeded);
        deadlineExceededCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void IntegrityRejected(string operation)
    {
        Interlocked.Increment(ref integrityRejected);
        integrityRejectedCounter.Add(
            1,
            new KeyValuePair<string, object?>(
                "operation",
                operation));
    }

    public void QueueEntered()
    {
        Interlocked.Increment(ref queuedQueries);
    }

    public void QueueExited()
    {
        while (true)
        {
            var current = Volatile.Read(ref queuedQueries);
            if (current <= 0)
            {
                return;
            }

            if (Interlocked.CompareExchange(
                    ref queuedQueries,
                    current - 1,
                    current) == current)
            {
                return;
            }
        }
    }

    public KentRehberiRuntimeSnapshot GetSnapshot()
    {
        return new KentRehberiRuntimeSnapshot(
            Volatile.Read(ref requestsStarted),
            Volatile.Read(ref requestsCompleted),
            Volatile.Read(ref requestsFailed),
            Volatile.Read(ref cacheHits),
            Volatile.Read(ref cacheMisses),
            Volatile.Read(ref cacheEvictions),
            Volatile.Read(ref singleFlightJoins),
            Volatile.Read(ref admissionRejected),
            Volatile.Read(ref deadlineExceeded),
            Volatile.Read(ref integrityRejected),
            Volatile.Read(ref activeQueries),
            Volatile.Read(ref queuedQueries));
    }

    public void Dispose()
    {
        activitySource.Dispose();
        meter.Dispose();
    }

    private void DecrementActive()
    {
        while (true)
        {
            var current = Volatile.Read(ref activeQueries);
            if (current <= 0)
            {
                return;
            }

            if (Interlocked.CompareExchange(
                    ref activeQueries,
                    current - 1,
                    current) == current)
            {
                return;
            }
        }
    }
}
