using System;
using System.Collections.Generic;

namespace Api.User.KentRehberi;

public sealed class KentRehberiOptions
{
    public const string SectionName = "KentRehberiData";
    public const string ConnectionStringName = "KentRehberi";
    public const string PlanAskiSource = "PlanAski";
    public const string PostgisSource = "Postgis";
    public const string OfficialPlanAskiBaseUri =
        "https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi";

    public bool Enabled { get; set; } = true;
    public string Source { get; set; } = PlanAskiSource;
    public string PlanAskiBaseUri { get; set; } = OfficialPlanAskiBaseUri;
    public short PlanAskiMinTur { get; set; } = 0;
    public short PlanAskiMaxTur { get; set; } = 42;
    public int PlanAskiRequestTimeoutSeconds { get; set; } = 10;
    public int PlanAskiCacheTtlSeconds { get; set; } = 300;
    public int PlanAskiMaxConcurrentRequests { get; set; } = 6;
    public int PlanAskiMaxRecordsPerType { get; set; } = 20_000;
    public long PlanAskiMaxResponseBytesPerType { get; set; } = 8 * 1024 * 1024;
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
    public int TypeCatalogMaxTypes { get; set; } = 256;
    public int TypeCatalogSamplesPerType { get; set; } = 8;
    public int TypeCatalogCacheTtlSeconds { get; set; } = 300;
    public int TypeCatalogMaxTextLength { get; set; } = 240;
    public int TypeCatalogMaxResponseBytes { get; set; } = 512 * 1024;

    // Cursor pagination is fail-closed because the source DDL does not declare
    // objectid UNIQUE. Enable only after the deployment duplicate preflight is clean.
    public bool ObjectIdCursorEnabled { get; set; }

    public IReadOnlyList<string> Validate()
    {
        var failures = new List<string>();

        if (!string.Equals(Source, PlanAskiSource, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(Source, PostgisSource, StringComparison.OrdinalIgnoreCase))
        {
            failures.Add("KentRehberiData:Source must be PlanAski or Postgis.");
        }

        if (string.Equals(Source, PlanAskiSource, StringComparison.OrdinalIgnoreCase) &&
            (!Uri.TryCreate(PlanAskiBaseUri, UriKind.Absolute, out var planAskiUri) ||
             !string.Equals(planAskiUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
             !string.Equals(planAskiUri.Host, "planaski.ankara.bel.tr", StringComparison.OrdinalIgnoreCase) ||
             planAskiUri.Port != 443 ||
             !string.Equals(
                 planAskiUri.AbsolutePath.TrimEnd('/'),
                 "/kentrehberiapi/api/kentrehberi",
                 StringComparison.OrdinalIgnoreCase) ||
             !string.IsNullOrEmpty(planAskiUri.UserInfo) ||
             !string.IsNullOrEmpty(planAskiUri.Query) ||
             !string.IsNullOrEmpty(planAskiUri.Fragment)))
        {
            failures.Add(
                "KentRehberiData:PlanAskiBaseUri must be the official HTTPS planaski.ankara.bel.tr Kent Rehberi endpoint.");
        }

        if (PlanAskiMinTur < 0 || PlanAskiMinTur > 42)
        {
            failures.Add("KentRehberiData:PlanAskiMinTur must be between 0 and 42.");
        }

        if (PlanAskiMaxTur < 0 || PlanAskiMaxTur > 42)
        {
            failures.Add("KentRehberiData:PlanAskiMaxTur must be between 0 and 42.");
        }

        if (PlanAskiMinTur > PlanAskiMaxTur)
        {
            failures.Add("KentRehberiData:PlanAskiMinTur cannot exceed PlanAskiMaxTur.");
        }

        if (PlanAskiRequestTimeoutSeconds is < 1 or > 60)
        {
            failures.Add("KentRehberiData:PlanAskiRequestTimeoutSeconds must be between 1 and 60.");
        }

        if (PlanAskiCacheTtlSeconds is < 15 or > 3600)
        {
            failures.Add("KentRehberiData:PlanAskiCacheTtlSeconds must be between 15 and 3600.");
        }

        if (PlanAskiMaxConcurrentRequests is < 1 or > 12)
        {
            failures.Add("KentRehberiData:PlanAskiMaxConcurrentRequests must be between 1 and 12.");
        }

        if (PlanAskiMaxRecordsPerType is < 1 or > 100_000)
        {
            failures.Add("KentRehberiData:PlanAskiMaxRecordsPerType must be between 1 and 100000.");
        }

        if (PlanAskiMaxResponseBytesPerType is < 262_144 or > 33_554_432)
        {
            failures.Add(
                "KentRehberiData:PlanAskiMaxResponseBytesPerType must be between 256 KiB and 32 MiB.");
        }

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

        if (TypeCatalogMaxTypes is < 1 or > 1024)
        {
            failures.Add("KentRehberiData:TypeCatalogMaxTypes must be between 1 and 1024.");
        }

        if (TypeCatalogSamplesPerType is < 1 or > 32)
        {
            failures.Add("KentRehberiData:TypeCatalogSamplesPerType must be between 1 and 32.");
        }

        if (TypeCatalogCacheTtlSeconds is < 1 or > 3600)
        {
            failures.Add("KentRehberiData:TypeCatalogCacheTtlSeconds must be between 1 and 3600.");
        }

        if (TypeCatalogMaxTextLength is < 32 or > 1024)
        {
            failures.Add("KentRehberiData:TypeCatalogMaxTextLength must be between 32 and 1024.");
        }

        if (TypeCatalogMaxResponseBytes is < 32768 or > 4194304)
        {
            failures.Add("KentRehberiData:TypeCatalogMaxResponseBytes must be between 32 KiB and 4 MiB.");
        }

        return failures;
    }
}
