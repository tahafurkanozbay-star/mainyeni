using System;

namespace Api.User.KentRehberi;

public sealed record KentRehberiQueryPlan(
    string Operation,
    string Fingerprint,
    TimeSpan Deadline,
    TimeSpan CacheTtl,
    bool Cacheable,
    int EstimatedCost)
{
    public static KentRehberiQueryPlan Search(
        KentRehberiSearchCriteria criteria,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(criteria);
        ArgumentNullException.ThrowIfNull(options);

        var cost = 10;
        cost += ScaleLimit(criteria.Limit, options.MaxLimit, 40);

        if (criteria.Query is not null)
        {
            cost += 18;
        }

        if (criteria.Bounds is not null)
        {
            var width = Math.Abs(
                criteria.Bounds.MaxLongitude -
                criteria.Bounds.MinLongitude);
            var height = Math.Abs(
                criteria.Bounds.MaxLatitude -
                criteria.Bounds.MinLatitude);
            var area = width * height;

            cost += area switch
            {
                <= 0.01d => 2,
                <= 0.1d => 6,
                <= 1d => 12,
                _ => 20
            };
        }
        else
        {
            cost += 24;
        }

        if (criteria.Ilce is not null)
        {
            cost -= 4;
        }

        if (criteria.Mahalle is not null)
        {
            cost -= 6;
        }

        if (criteria.Tur.HasValue)
        {
            cost -= 4;
        }

        var ttlSeconds = options.ResultCacheTtlSeconds;
        if (criteria.Bounds is null &&
            criteria.Ilce is null &&
            criteria.Mahalle is null &&
            !criteria.Tur.HasValue &&
            criteria.Query is null)
        {
            ttlSeconds = Math.Max(1, ttlSeconds / 2);
        }

        return new KentRehberiQueryPlan(
            "search",
            KentRehberiQueryFingerprint.ForSearch(criteria),
            TimeSpan.FromMilliseconds(
                options.QueryDeadlineMilliseconds),
            TimeSpan.FromSeconds(ttlSeconds),
            options.ResultCacheEnabled,
            Math.Clamp(cost, 1, 100));
    }

    public static KentRehberiQueryPlan Nearby(
        KentRehberiNearbyCriteria criteria,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(criteria);
        ArgumentNullException.ThrowIfNull(options);

        var radiusRatio = Math.Clamp(
            criteria.RadiusMeters /
            Math.Max(1d, options.MaxRadiusMeters),
            0d,
            1d);

        var cost = 18;
        cost += ScaleLimit(criteria.Limit, options.MaxLimit, 35);
        cost += (int)Math.Round(
            radiusRatio * 30d,
            MidpointRounding.AwayFromZero);

        if (criteria.Query is not null)
        {
            cost += 12;
        }

        if (criteria.Ilce is not null)
        {
            cost -= 4;
        }

        if (criteria.Mahalle is not null)
        {
            cost -= 6;
        }

        if (criteria.Tur.HasValue)
        {
            cost -= 4;
        }

        return new KentRehberiQueryPlan(
            "nearby",
            KentRehberiQueryFingerprint.ForNearby(criteria),
            TimeSpan.FromMilliseconds(
                options.QueryDeadlineMilliseconds),
            TimeSpan.FromSeconds(
                Math.Max(
                    1,
                    options.ResultCacheTtlSeconds / 3)),
            options.ResultCacheEnabled,
            Math.Clamp(cost, 1, 100));
    }

    public static KentRehberiQueryPlan ObjectById(
        int objectId,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return new KentRehberiQueryPlan(
            "object",
            KentRehberiQueryFingerprint.ForObjectId(objectId),
            TimeSpan.FromMilliseconds(
                options.QueryDeadlineMilliseconds),
            TimeSpan.Zero,
            false,
            1);
    }

    private static int ScaleLimit(
        int limit,
        int maxLimit,
        int ceiling)
    {
        if (limit <= 0 || maxLimit <= 0)
        {
            return 0;
        }

        var ratio = Math.Clamp(
            (double)limit / maxLimit,
            0d,
            1d);

        return (int)Math.Round(
            ratio * ceiling,
            MidpointRounding.AwayFromZero);
    }
}
