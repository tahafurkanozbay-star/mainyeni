using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public sealed record KentRehberiSingleFlightSnapshot(
    int InFlight,
    long Created,
    long Joined,
    long Completed,
    long CancelledWhenUnused);

public sealed class KentRehberiSingleFlight<T> : IDisposable
{
    private readonly ConcurrentDictionary<string, Entry> entries =
        new(StringComparer.Ordinal);
    private readonly KentRehberiTelemetry telemetry;

    private long created;
    private long joined;
    private long completed;
    private long cancelledWhenUnused;
    private int disposed;

    public KentRehberiSingleFlight(
        KentRehberiTelemetry telemetry)
    {
        ArgumentNullException.ThrowIfNull(telemetry);
        this.telemetry = telemetry;
    }

    public async Task<T> RunAsync(
        string operation,
        string key,
        TimeSpan deadline,
        Func<CancellationToken, Task<T>> factory,
        CancellationToken subscriberCancellationToken)
    {
        ThrowIfDisposed();
        ArgumentException.ThrowIfNullOrWhiteSpace(operation);
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(factory);

        if (deadline <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(deadline),
                "deadline must be positive.");
        }

        Entry entry;

        while (true)
        {
            if (entries.TryGetValue(
                    key,
                    out var existing))
            {
                entry = existing;
                Interlocked.Increment(ref joined);
                telemetry.SingleFlightJoined(operation);
                break;
            }

            var candidate = new Entry(
                deadline,
                factory,
                CompleteEntry,
                key);

            if (entries.TryAdd(
                    key,
                    candidate))
            {
                entry = candidate;
                Interlocked.Increment(ref created);
                break;
            }

            candidate.Dispose();
        }

        entry.AddSubscriber();

        try
        {
            return await entry.Task
                .WaitAsync(subscriberCancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            if (entry.ReleaseSubscriber())
            {
                Interlocked.Increment(ref cancelledWhenUnused);
            }
        }
    }

    public KentRehberiSingleFlightSnapshot GetSnapshot()
    {
        return new KentRehberiSingleFlightSnapshot(
            entries.Count,
            Math.Max(0, Volatile.Read(ref created)),
            Math.Max(0, Volatile.Read(ref joined)),
            Math.Max(0, Volatile.Read(ref completed)),
            Math.Max(0, Volatile.Read(ref cancelledWhenUnused)));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        foreach (var entry in entries.Values)
        {
            entry.Dispose();
        }

        entries.Clear();
    }

    private void CompleteEntry(
        string key,
        Entry completedEntry)
    {
        ((ICollection<KeyValuePair<string, Entry>>)entries).Remove(
            new KeyValuePair<string, Entry>(
                key,
                completedEntry));
        Interlocked.Increment(ref completed);
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref disposed) != 0,
            this);
    }

    private sealed class Entry : IDisposable
    {
        private readonly CancellationTokenSource workCancellation;
        private readonly Lazy<Task<T>> taskFactory;
        private readonly Action<string, Entry> completed;
        private readonly string key;
        private int subscribers;
        private int completionSignalled;
        private int disposed;

        public Entry(
            TimeSpan deadline,
            Func<CancellationToken, Task<T>> factory,
            Action<string, Entry> completed,
            string key)
        {
            this.completed = completed;
            this.key = key;
            workCancellation = new CancellationTokenSource(deadline);
            taskFactory = new Lazy<Task<T>>(
                () => ExecuteAsync(factory),
                LazyThreadSafetyMode.ExecutionAndPublication);
        }

        public Task<T> Task => taskFactory.Value;

        public void AddSubscriber()
        {
            ObjectDisposedException.ThrowIf(
                Volatile.Read(ref disposed) != 0,
                this);
            Interlocked.Increment(ref subscribers);
        }

        public bool ReleaseSubscriber()
        {
            var remaining = Interlocked.Decrement(ref subscribers);
            if (remaining > 0 || Task.IsCompleted)
            {
                return false;
            }

            try
            {
                workCancellation.Cancel();
                return true;
            }
            catch (ObjectDisposedException)
            {
                return false;
            }
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0)
            {
                return;
            }

            try
            {
                workCancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }

            workCancellation.Dispose();
        }

        private async Task<T> ExecuteAsync(
            Func<CancellationToken, Task<T>> factory)
        {
            try
            {
                return await factory(workCancellation.Token)
                    .ConfigureAwait(false);
            }
            finally
            {
                if (Interlocked.Exchange(
                        ref completionSignalled,
                        1) == 0)
                {
                    completed(key, this);
                }

                Dispose();
            }
        }
    }
}
