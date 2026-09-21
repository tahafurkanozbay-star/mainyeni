using System;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public sealed class KentRehberiOverloadedException : InvalidOperationException
{
    public KentRehberiOverloadedException(string message)
        : base(message)
    {
    }
}

public sealed record KentRehberiAdmissionSnapshot(
    int MaxConcurrent,
    int MaxQueued,
    int Active,
    int Queued,
    long Accepted,
    long Rejected);

public sealed class KentRehberiAdmissionController : IDisposable
{
    private readonly SemaphoreSlim concurrency;
    private readonly KentRehberiTelemetry telemetry;
    private readonly int maxConcurrent;
    private readonly int maxQueued;

    private int active;
    private int queued;
    private long accepted;
    private long rejected;
    private int disposed;

    public KentRehberiAdmissionController(
        KentRehberiOptions options,
        KentRehberiTelemetry telemetry)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(telemetry);

        maxConcurrent = options.MaxConcurrentQueries;
        maxQueued = options.MaxQueuedQueries;
        this.telemetry = telemetry;
        concurrency = new SemaphoreSlim(
            maxConcurrent,
            maxConcurrent);
    }

    public async ValueTask<KentRehberiAdmissionLease> AcquireAsync(
        string operation,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        ArgumentException.ThrowIfNullOrWhiteSpace(operation);

        if (concurrency.Wait(0))
        {
            Interlocked.Increment(ref active);
            Interlocked.Increment(ref accepted);
            return new KentRehberiAdmissionLease(this);
        }

        var queuedNow = Interlocked.Increment(ref queued);
        if (queuedNow > maxQueued)
        {
            Interlocked.Decrement(ref queued);
            Interlocked.Increment(ref rejected);
            telemetry.AdmissionRejected(operation);
            throw new KentRehberiOverloadedException(
                "Kent Rehberi query capacity is temporarily saturated.");
        }

        telemetry.QueueEntered();

        try
        {
            await concurrency
                .WaitAsync(cancellationToken)
                .ConfigureAwait(false);

            Interlocked.Increment(ref active);
            Interlocked.Increment(ref accepted);
            return new KentRehberiAdmissionLease(this);
        }
        finally
        {
            Interlocked.Decrement(ref queued);
            telemetry.QueueExited();
        }
    }

    public KentRehberiAdmissionSnapshot GetSnapshot()
    {
        return new KentRehberiAdmissionSnapshot(
            maxConcurrent,
            maxQueued,
            Math.Max(0, Volatile.Read(ref active)),
            Math.Max(0, Volatile.Read(ref queued)),
            Math.Max(0, Volatile.Read(ref accepted)),
            Math.Max(0, Volatile.Read(ref rejected)));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        concurrency.Dispose();
    }

    internal void Release()
    {
        if (Volatile.Read(ref disposed) != 0)
        {
            return;
        }

        var previous = Interlocked.Decrement(ref active);
        if (previous < 0)
        {
            Interlocked.Exchange(ref active, 0);
            return;
        }

        concurrency.Release();
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref disposed) != 0,
            this);
    }
}

public sealed class KentRehberiAdmissionLease : IDisposable
{
    private KentRehberiAdmissionController? owner;

    internal KentRehberiAdmissionLease(
        KentRehberiAdmissionController owner)
    {
        this.owner = owner;
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref owner, null)?.Release();
    }
}
