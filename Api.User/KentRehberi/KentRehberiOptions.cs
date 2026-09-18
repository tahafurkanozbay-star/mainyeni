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

        if (MaxLimit is < 1 or > 10_000)
        {
            failures.Add("KentRehberiData:MaxLimit must be between 1 and 10000.");
        }

        if (DefaultLimit > MaxLimit)
        {
            failures.Add("KentRehberiData:DefaultLimit cannot exceed MaxLimit.");
        }

        if (MaxRadiusMeters is < 100 or > 200_000)
        {
            failures.Add("KentRehberiData:MaxRadiusMeters must be between 100 and 200000.");
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

        return failures;
    }
}
