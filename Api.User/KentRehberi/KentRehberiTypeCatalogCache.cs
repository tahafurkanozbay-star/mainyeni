using System;

namespace Api.User.KentRehberi;

public sealed record KentRehberiTypeCatalogCacheSnapshot(
    bool HasValue,
    DateTimeOffset? ExpiresAt,
    long Hits,
    long Misses,
    long Writes);

public sealed class KentRehberiTypeCatalogCache
{
    private readonly object sync = new();
    private readonly KentRehberiOptions options;
    private readonly TimeProvider timeProvider;

    private KentRehberiTypeCatalog? value;
    private DateTimeOffset expiresAt;
    private long hits;
    private long misses;
    private long writes;

    public KentRehberiTypeCatalogCache(
        KentRehberiOptions options,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(timeProvider);
        this.options = options;
        this.timeProvider = timeProvider;
    }

    public bool TryGet(
        out KentRehberiTypeCatalog catalog)
    {
        lock (sync)
        {
            if (value is null)
            {
                misses++;
                catalog = null!;
                return false;
            }

            var now = timeProvider.GetUtcNow();
            if (expiresAt <= now)
            {
                value = null;
                expiresAt = default;
                misses++;
                catalog = null!;
                return false;
            }

            hits++;
            catalog = value;
            return true;
        }
    }

    public void Set(KentRehberiTypeCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(catalog);

        lock (sync)
        {
            value = catalog;
            expiresAt =
                timeProvider.GetUtcNow().AddSeconds(
                    options.TypeCatalogCacheTtlSeconds);
            writes++;
        }
    }

    public void Clear()
    {
        lock (sync)
        {
            value = null;
            expiresAt = default;
        }
    }

    public KentRehberiTypeCatalogCacheSnapshot GetSnapshot()
    {
        lock (sync)
        {
            var hasValue =
                value is not null &&
                expiresAt > timeProvider.GetUtcNow();

            return new KentRehberiTypeCatalogCacheSnapshot(
                hasValue,
                hasValue ? expiresAt : null,
                hits,
                misses,
                writes);
        }
    }
}
