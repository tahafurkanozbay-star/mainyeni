using System;
using System.Collections.Generic;

namespace Api.User.KentRehberi;

public sealed record KentRehberiCacheSnapshot(
    int Entries,
    long Bytes,
    int MaxEntries,
    long MaxBytes,
    long Hits,
    long Misses,
    long Writes,
    long Replacements,
    long Expired,
    long CapacityEvictions,
    long OversizeRejected);

public sealed class KentRehberiBoundedResultCache
{
    private sealed class CacheEntry
    {
        public required string Key { get; init; }
        public required KentRehberiFeatureCollection Value { get; init; }
        public required long SizeBytes { get; init; }
        public required DateTimeOffset ExpiresAtUtc { get; init; }
        public required LinkedListNode<string> LruNode { get; init; }
    }

    private readonly object sync = new();
    private readonly Dictionary<string, CacheEntry> entries =
        new(StringComparer.Ordinal);
    private readonly LinkedList<string> lru = new();
    private readonly KentRehberiOptions options;
    private readonly KentRehberiTelemetry telemetry;
    private readonly TimeProvider timeProvider;

    private long currentBytes;
    private long hits;
    private long misses;
    private long writes;
    private long replacements;
    private long expired;
    private long capacityEvictions;
    private long oversizeRejected;

    public KentRehberiBoundedResultCache(
        KentRehberiOptions options,
        KentRehberiTelemetry telemetry,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(telemetry);
        ArgumentNullException.ThrowIfNull(timeProvider);

        this.options = options;
        this.telemetry = telemetry;
        this.timeProvider = timeProvider;
    }

    public bool TryGet(
        string key,
        out KentRehberiFeatureCollection? value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);

        lock (sync)
        {
            if (!entries.TryGetValue(key, out var entry))
            {
                misses++;
                value = null;
                return false;
            }

            var now = timeProvider.GetUtcNow();
            if (entry.ExpiresAtUtc <= now)
            {
                RemoveUnsafe(entry, "expired");
                expired++;
                misses++;
                value = null;
                return false;
            }

            TouchUnsafe(entry);
            hits++;
            value = entry.Value;
            return true;
        }
    }

    public bool Set(
        string key,
        KentRehberiFeatureCollection value,
        long sizeBytes,
        TimeSpan ttl)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(value);

        if (!options.ResultCacheEnabled ||
            ttl <= TimeSpan.Zero ||
            sizeBytes <= 0)
        {
            return false;
        }

        if (sizeBytes > options.ResultCacheMaxBytes)
        {
            lock (sync)
            {
                oversizeRejected++;
            }

            return false;
        }

        lock (sync)
        {
            if (entries.TryGetValue(key, out var existing))
            {
                RemoveUnsafe(existing, "replace");
                replacements++;
            }

            var node = lru.AddFirst(key);
            var entry = new CacheEntry
            {
                Key = key,
                Value = value,
                SizeBytes = sizeBytes,
                ExpiresAtUtc = timeProvider.GetUtcNow().Add(ttl),
                LruNode = node
            };

            entries.Add(key, entry);
            currentBytes += sizeBytes;
            writes++;

            TrimUnsafe();
            return entries.ContainsKey(key);
        }
    }

    public int SweepExpired(int maxToRemove = 64)
    {
        if (maxToRemove <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxToRemove));
        }

        lock (sync)
        {
            var now = timeProvider.GetUtcNow();
            var removed = 0;
            var node = lru.Last;

            while (node is not null &&
                   removed < maxToRemove)
            {
                var previous = node.Previous;
                if (entries.TryGetValue(
                        node.Value,
                        out var entry) &&
                    entry.ExpiresAtUtc <= now)
                {
                    RemoveUnsafe(entry, "expired");
                    expired++;
                    removed++;
                }

                node = previous;
            }

            return removed;
        }
    }

    public void Clear()
    {
        lock (sync)
        {
            entries.Clear();
            lru.Clear();
            currentBytes = 0;
        }
    }

    public KentRehberiCacheSnapshot GetSnapshot()
    {
        lock (sync)
        {
            return new KentRehberiCacheSnapshot(
                entries.Count,
                Math.Max(0, currentBytes),
                options.ResultCacheMaxEntries,
                options.ResultCacheMaxBytes,
                Math.Max(0, hits),
                Math.Max(0, misses),
                Math.Max(0, writes),
                Math.Max(0, replacements),
                Math.Max(0, expired),
                Math.Max(0, capacityEvictions),
                Math.Max(0, oversizeRejected));
        }
    }

    private void TrimUnsafe()
    {
        while (entries.Count > options.ResultCacheMaxEntries ||
               currentBytes > options.ResultCacheMaxBytes)
        {
            var tail = lru.Last;
            if (tail is null)
            {
                currentBytes = 0;
                return;
            }

            if (!entries.TryGetValue(
                    tail.Value,
                    out var entry))
            {
                lru.RemoveLast();
                continue;
            }

            RemoveUnsafe(entry, "capacity");
            capacityEvictions++;
        }
    }

    private void TouchUnsafe(CacheEntry entry)
    {
        if (ReferenceEquals(
                lru.First,
                entry.LruNode))
        {
            return;
        }

        lru.Remove(entry.LruNode);
        lru.AddFirst(entry.LruNode);
    }

    private void RemoveUnsafe(
        CacheEntry entry,
        string reason)
    {
        entries.Remove(entry.Key);
        lru.Remove(entry.LruNode);
        currentBytes = Math.Max(
            0,
            currentBytes - entry.SizeBytes);

        if (reason is "capacity" or "expired")
        {
            telemetry.CacheEvicted(reason);
        }
    }
}
