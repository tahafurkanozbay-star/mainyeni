using System;
using System.Collections.Generic;

namespace Api.User.KentRehberi;

public sealed class KentRehberiOptions
{
    public const string SectionName = "KentRehberiData";
    public const string ConnectionStringName = "KentRehberi";

    public bool Enabled { get; set; } = true;
    public int DefaultLimit { get; set; } = 500;
    public int MaxLimit { get; set; } = 2_000;
    public int MaxRadiusMeters { get; set; } = 50_000;
    public int CommandTimeoutSeconds { get; set; } = 8;
    public int ConnectionTimeoutSeconds { get; set; } = 5;
    public int MaxPoolSize { get; set; } = 40;
    public int CacheMaxAgeSeconds { get; set; } = 30;
    public int HealthCheckTimeoutSeconds { get; set; } = 3;
    public bool ResultCacheEnabled { get; set; } = true;
    public int ResultCacheTtlSeconds { get; set; } = 20;
    public int ResultCacheMaxEntries { get; set; } = 256;
    public long ResultCacheMaxBytes { get; set; } = 16 * 1024 * 1024;
    public int MaxConcurrentQueries { get; set; } = 12;
    public int MaxQueuedQueries { get; set; } = 48;
    public int QueryDeadlineMilliseconds { get; set; } = 7_000;
    public long MaxResponseBytes { get; set; } = 8 * 1024 * 1024;
    public int MaxResponseFeatures { get; set; } = 2_000;
    public int MaxGeometryDepth { get; set; } = 32;
    public int MaxGeometryNodesPerFeature { get; set; } = 100_000;
    public int MaxGeometryNodesPerResponse { get; set; } = 500_000;

    // Cursor pagination is fail-closed because the source DDL does not declare
    // objectid UNIQUE. Enable only after the deployment duplicate preflight is clean.
    public bool ObjectIdCursorEnabled { get; set; }

    public IReadOnlyList<string> Validate()
    {
        var failures = new List<string>();

        if (DefaultLimit is < 1 or > 2_000)
        {
            failures.Add("KentRehberiData:DefaultLimit must be between 1 and 2000.");
        }

        if (MaxLimit is < 1 or > 2_000)
        {
            failures.Add("KentRehberiData:MaxLimit must be between 1 and 2000.");
        }

        if (DefaultLimit > MaxLimit)
        {
            failures.Add("KentRehberiData:DefaultLimit cannot exceed MaxLimit.");
        }

        if (MaxRadiusMeters is < 100 or > 50_000)
        {
            failures.Add("KentRehberiData:MaxRadiusMeters must be between 100 and 50000.");
        }

        if (CommandTimeoutSeconds is < 1 or > 60)
        {
            failures.Add("KentRehberiData:CommandTimeoutSeconds must be between 1 and 60.");
        }

        if (ConnectionTimeoutSeconds is < 1 or > 30)
        {
            failures.Add("KentRehberiData:ConnectionTimeoutSeconds must be between 1 and 30.");
        }

        if (MaxPoolSize is < 1 or > 200)
        {
            failures.Add("KentRehberiData:MaxPoolSize must be between 1 and 200.");
        }

        if (CacheMaxAgeSeconds is < 0 or > 3_600)
        {
            failures.Add("KentRehberiData:CacheMaxAgeSeconds must be between 0 and 3600.");
        }

        if (HealthCheckTimeoutSeconds is < 1 or > 15)
        {
            failures.Add("KentRehberiData:HealthCheckTimeoutSeconds must be between 1 and 15.");
        }

        if (ResultCacheTtlSeconds is < 1 or > 600)
        {
            failures.Add("KentRehberiData:ResultCacheTtlSeconds must be between 1 and 600.");
        }

        if (ResultCacheMaxEntries is < 1 or > 4096)
        {
            failures.Add("KentRehberiData:ResultCacheMaxEntries must be between 1 and 4096.");
        }

        if (ResultCacheMaxBytes is < 1_048_576 or > 268_435_456)
        {
            failures.Add("KentRehberiData:ResultCacheMaxBytes must be between 1 MiB and 256 MiB.");
        }

        if (MaxConcurrentQueries is < 1 or > 128)
        {
            failures.Add("KentRehberiData:MaxConcurrentQueries must be between 1 and 128.");
        }

        if (MaxQueuedQueries is < 0 or > 4096)
        {
            failures.Add("KentRehberiData:MaxQueuedQueries must be between 0 and 4096.");
        }

        if (QueryDeadlineMilliseconds is < 250 or > 60_000)
        {
            failures.Add("KentRehberiData:QueryDeadlineMilliseconds must be between 250 and 60000.");
        }

        if (MaxResponseBytes is < 262_144 or > 67_108_864)
        {
            failures.Add("KentRehberiData:MaxResponseBytes must be between 256 KiB and 64 MiB.");
        }

        if (MaxResponseFeatures is < 1 or > 2_000)
        {
            failures.Add("KentRehberiData:MaxResponseFeatures must be between 1 and 2000.");
        }

        if (MaxResponseFeatures < MaxLimit)
        {
            failures.Add("KentRehberiData:MaxResponseFeatures cannot be lower than MaxLimit.");
        }

        if (MaxGeometryDepth is < 4 or > 128)
        {
            failures.Add("KentRehberiData:MaxGeometryDepth must be between 4 and 128.");
        }

        if (MaxGeometryNodesPerFeature is < 100 or > 1_000_000)
        {
            failures.Add("KentRehberiData:MaxGeometryNodesPerFeature must be between 100 and 1000000.");
        }

        if (MaxGeometryNodesPerResponse is < 1_000 or > 5_000_000)
        {
            failures.Add("KentRehberiData:MaxGeometryNodesPerResponse must be between 1000 and 5000000.");
        }

        if (MaxGeometryNodesPerResponse < MaxGeometryNodesPerFeature)
        {
            failures.Add("KentRehberiData:MaxGeometryNodesPerResponse cannot be lower than MaxGeometryNodesPerFeature.");
        }

        return failures;
    }
}
