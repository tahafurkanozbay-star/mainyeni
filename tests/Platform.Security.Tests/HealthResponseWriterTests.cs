using Api.Core.Platform.Health;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class HealthResponseWriterTests
{
    [Fact]
    public async Task Write_EmitsMinimalHealthyPayload()
    {
        var context = CreateContext();
        var report = new HealthReport(
            new Dictionary<string, HealthReportEntry>
            {
                ["self"] = Entry(HealthStatus.Healthy, "process ok", 2)
            },
            TimeSpan.FromMilliseconds(3));

        await HealthResponseWriter.Write(context, report);

        var body = await ReadBody(context);
        Assert.Equal("application/json; charset=utf-8", context.Response.ContentType);
        Assert.Equal("no-store, no-cache, max-age=0", context.Response.Headers.CacheControl.ToString());
        Assert.Equal("no-cache", context.Response.Headers.Pragma.ToString());
        Assert.Contains("\"status\":\"healthy\"", body, StringComparison.Ordinal);
        Assert.Contains("\"name\":\"self\"", body, StringComparison.Ordinal);
        Assert.Contains("\"durationMs\":2", body, StringComparison.Ordinal);
        Assert.DoesNotContain("process ok", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Write_MapsDegradedStatusWithoutLeakingDescription()
    {
        var context = CreateContext();
        var report = new HealthReport(
            new Dictionary<string, HealthReportEntry>
            {
                ["dependency"] = Entry(HealthStatus.Degraded, "private upstream details", 8)
            },
            TimeSpan.FromMilliseconds(9));

        await HealthResponseWriter.Write(context, report);

        var body = await ReadBody(context);
        Assert.Contains("\"status\":\"degraded\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain("private upstream details", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Write_MapsUnhealthyStatusWithoutLeakingExceptionOrDiagnosticData()
    {
        var context = CreateContext();
        const string secret = "Host=secret-db;Password=do-not-leak";
        var entry = new HealthReportEntry(
            HealthStatus.Unhealthy,
            "database unavailable " + secret,
            TimeSpan.FromMilliseconds(12),
            new InvalidOperationException(secret),
            new Dictionary<string, object>
            {
                ["connection"] = secret,
                ["durationMs"] = 12L
            });
        var report = new HealthReport(
            new Dictionary<string, HealthReportEntry>
            {
                ["database"] = entry
            },
            TimeSpan.FromMilliseconds(15));

        await HealthResponseWriter.Write(context, report);

        var body = await ReadBody(context);
        Assert.Contains("\"status\":\"unhealthy\"", body, StringComparison.Ordinal);
        Assert.Contains("\"name\":\"database\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain(secret, body, StringComparison.Ordinal);
        Assert.DoesNotContain("InvalidOperationException", body, StringComparison.Ordinal);
        Assert.DoesNotContain("connection", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Write_SortsChecksByNameForStableDiagnostics()
    {
        var context = CreateContext();
        var report = new HealthReport(
            new Dictionary<string, HealthReportEntry>
            {
                ["zeta"] = Entry(HealthStatus.Healthy, null, 1),
                ["alpha"] = Entry(HealthStatus.Healthy, null, 1),
                ["middle"] = Entry(HealthStatus.Healthy, null, 1)
            },
            TimeSpan.FromMilliseconds(5));

        await HealthResponseWriter.Write(context, report);

        var body = await ReadBody(context);
        var alpha = body.IndexOf("\"alpha\"", StringComparison.Ordinal);
        var middle = body.IndexOf("\"middle\"", StringComparison.Ordinal);
        var zeta = body.IndexOf("\"zeta\"", StringComparison.Ordinal);
        Assert.True(alpha >= 0 && middle > alpha && zeta > middle);
    }

    [Fact]
    public async Task Write_HandlesEmptyReport()
    {
        var context = CreateContext();
        var report = new HealthReport(
            new Dictionary<string, HealthReportEntry>(),
            HealthStatus.Healthy,
            TimeSpan.Zero);

        await HealthResponseWriter.Write(context, report);

        var body = await ReadBody(context);
        Assert.Contains("\"status\":\"healthy\"", body, StringComparison.Ordinal);
        Assert.Contains("\"checks\":[]", body, StringComparison.Ordinal);
        Assert.Contains("\"totalDurationMs\":0", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Write_ClampsNegativeDurationsToZero()
    {
        var context = CreateContext();
        var report = new HealthReport(
            new Dictionary<string, HealthReportEntry>
            {
                ["self"] = Entry(HealthStatus.Healthy, null, -5)
            },
            HealthStatus.Healthy,
            TimeSpan.FromMilliseconds(-10));

        await HealthResponseWriter.Write(context, report);

        var body = await ReadBody(context);
        Assert.Contains("\"totalDurationMs\":0", body, StringComparison.Ordinal);
        Assert.Contains("\"durationMs\":0", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Write_ThrowsForNullContext()
    {
        var report = new HealthReport(new Dictionary<string, HealthReportEntry>(), TimeSpan.Zero);

        await Assert.ThrowsAsync<ArgumentNullException>(() => HealthResponseWriter.Write(null!, report));
    }

    [Fact]
    public async Task Write_ThrowsForNullReport()
    {
        var context = CreateContext();

        await Assert.ThrowsAsync<ArgumentNullException>(() => HealthResponseWriter.Write(context, null!));
    }

    private static HealthReportEntry Entry(HealthStatus status, string? description, int milliseconds)
    {
        return new HealthReportEntry(
            status,
            description,
            TimeSpan.FromMilliseconds(milliseconds),
            exception: null,
            data: null);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static async Task<string> ReadBody(HttpContext context)
    {
        context.Response.Body.Position = 0;
        using var reader = new StreamReader(
            context.Response.Body,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: false,
            leaveOpen: true);
        return await reader.ReadToEndAsync();
    }
}
