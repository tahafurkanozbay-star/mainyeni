using Api.Core.Platform.Health;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class HealthResponseWriterBoundaryTests
    {
        [Theory]
        [InlineData(HealthStatus.Healthy, "healthy")]
        [InlineData(HealthStatus.Degraded, "degraded")]
        [InlineData(HealthStatus.Unhealthy, "unhealthy")]
        public async Task PublicStatus_UsesClosedStableVocabulary(
            HealthStatus status,
            string expected)
        {
            var context = CreateContext();
            var report = CreateReport(
                status,
                new Dictionary<string, HealthReportEntry>());

            await HealthResponseWriter.Write(context, report);

            using var document = ReadJson(context);
            Assert.Equal(expected, document.RootElement.GetProperty("status").GetString());
        }

        [Fact]
        public async Task Response_DoesNotExposeExceptionDescriptionOrDiagnosticData()
        {
            var context = CreateContext();
            var entries = new Dictionary<string, HealthReportEntry>
            {
                ["database"] = new HealthReportEntry(
                    HealthStatus.Unhealthy,
                    "postgres://db-secret-host/internal-secret",
                    TimeSpan.FromMilliseconds(17),
                    new InvalidOperationException("credential-secret password=do-not-leak"),
                    new Dictionary<string, object>
                    {
                        ["connectionString"] = "Host=db-secret-host;Password=do-not-leak",
                        ["token"] = "sensitive-token"
                    })
            };
            var report = CreateReport(HealthStatus.Unhealthy, entries);

            await HealthResponseWriter.Write(context, report);

            var body = ReadBody(context);
            Assert.DoesNotContain("db-secret-host", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("do-not-leak", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("sensitive-token", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("connectionString", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("credential-secret", body, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task Response_ContainsOnlyBoundedPublicFieldsPerCheck()
        {
            var context = CreateContext();
            var report = CreateReport(
                HealthStatus.Unhealthy,
                new Dictionary<string, HealthReportEntry>
                {
                    ["database"] = Entry(HealthStatus.Unhealthy, 11),
                    ["lifecycle"] = Entry(HealthStatus.Healthy, 2)
                });

            await HealthResponseWriter.Write(context, report);

            using var document = ReadJson(context);
            var root = document.RootElement;
            Assert.Equal(3, root.EnumerateObject().Count());
            Assert.True(root.TryGetProperty("status", out _));
            Assert.True(root.TryGetProperty("totalDurationMs", out _));
            var checks = root.GetProperty("checks");
            Assert.Equal(2, checks.GetArrayLength());

            foreach (var check in checks.EnumerateArray())
            {
                var names = check
                    .EnumerateObject()
                    .Select(property => property.Name)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray();
                Assert.Equal(
                    new[] { "durationMs", "name", "status" },
                    names);
            }
        }

        [Fact]
        public async Task Checks_AreOrderedDeterministicallyByRegistrationName()
        {
            var context = CreateContext();
            var report = CreateReport(
                HealthStatus.Healthy,
                new Dictionary<string, HealthReportEntry>
                {
                    ["z-last"] = Entry(HealthStatus.Healthy, 1),
                    ["database"] = Entry(HealthStatus.Healthy, 2),
                    ["a-first"] = Entry(HealthStatus.Healthy, 3),
                    ["lifecycle"] = Entry(HealthStatus.Healthy, 4)
                });

            await HealthResponseWriter.Write(context, report);

            using var document = ReadJson(context);
            var names = document.RootElement
                .GetProperty("checks")
                .EnumerateArray()
                .Select(value => value.GetProperty("name").GetString())
                .ToArray();
            Assert.Equal(
                new[] { "a-first", "database", "lifecycle", "z-last" },
                names);
        }

        [Fact]
        public async Task CacheHeaders_ExplicitlyDisableHealthResponseCaching()
        {
            var context = CreateContext();
            var report = CreateReport(
                HealthStatus.Healthy,
                new Dictionary<string, HealthReportEntry>());

            await HealthResponseWriter.Write(context, report);

            Assert.Equal(
                "no-store, no-cache, max-age=0",
                context.Response.Headers["Cache-Control"].ToString());
            Assert.Equal("no-cache", context.Response.Headers["Pragma"].ToString());
            Assert.Equal("application/json; charset=utf-8", context.Response.ContentType);
        }

        [Fact]
        public async Task DurationValues_AreEmittedAsMillisecondsOnly()
        {
            var context = CreateContext();
            var report = new HealthReport(
                new Dictionary<string, HealthReportEntry>
                {
                    ["database"] = Entry(HealthStatus.Healthy, 123)
                },
                TimeSpan.FromMilliseconds(456));

            await HealthResponseWriter.Write(context, report);

            using var document = ReadJson(context);
            Assert.Equal(456, document.RootElement.GetProperty("totalDurationMs").GetInt64());
            Assert.Equal(
                123,
                document.RootElement
                    .GetProperty("checks")[0]
                    .GetProperty("durationMs")
                    .GetInt64());
        }

        [Fact]
        public async Task EmptyReport_ProducesStableMinimalPayload()
        {
            var context = CreateContext();
            var report = CreateReport(
                HealthStatus.Healthy,
                new Dictionary<string, HealthReportEntry>());

            await HealthResponseWriter.Write(context, report);

            using var document = ReadJson(context);
            Assert.Equal("healthy", document.RootElement.GetProperty("status").GetString());
            Assert.Equal(0, document.RootElement.GetProperty("checks").GetArrayLength());
            Assert.True(context.Response.Body.Length < 256);
        }

        [Fact]
        public async Task EntryStatusVocabulary_IsClosedForAllHealthStates()
        {
            var context = CreateContext();
            var report = CreateReport(
                HealthStatus.Unhealthy,
                new Dictionary<string, HealthReportEntry>
                {
                    ["healthy"] = Entry(HealthStatus.Healthy, 1),
                    ["degraded"] = Entry(HealthStatus.Degraded, 1),
                    ["unhealthy"] = Entry(HealthStatus.Unhealthy, 1)
                });

            await HealthResponseWriter.Write(context, report);

            using var document = ReadJson(context);
            var statuses = document.RootElement
                .GetProperty("checks")
                .EnumerateArray()
                .Select(value => value.GetProperty("status").GetString())
                .ToHashSet(StringComparer.Ordinal);

            Assert.Equal(3, statuses.Count);
            Assert.Contains("healthy", statuses);
            Assert.Contains("degraded", statuses);
            Assert.Contains("unhealthy", statuses);
        }

        [Fact]
        public async Task PublicPayloadDoesNotEchoRequestHeadersQueryOrTraceIdentifier()
        {
            var context = CreateContext();
            context.TraceIdentifier = "trace-secret";
            context.Request.QueryString = new QueryString("?secret=query-secret");
            context.Request.Headers["Authorization"] = "Bearer header-secret";
            context.Request.Headers["Cookie"] = "session=cookie-secret";
            var report = CreateReport(
                HealthStatus.Healthy,
                new Dictionary<string, HealthReportEntry>
                {
                    ["self"] = Entry(HealthStatus.Healthy, 1)
                });

            await HealthResponseWriter.Write(context, report);

            var body = ReadBody(context);
            Assert.DoesNotContain("trace-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("query-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("header-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("cookie-secret", body, StringComparison.Ordinal);
        }

        [Fact]
        public async Task CheckNameIsTheOnlyRegistrationIdentityExposed()
        {
            var context = CreateContext();
            var report = CreateReport(
                HealthStatus.Healthy,
                new Dictionary<string, HealthReportEntry>
                {
                    ["database"] = new HealthReportEntry(
                        HealthStatus.Healthy,
                        "internal-description-secret",
                        TimeSpan.FromMilliseconds(1),
                        null,
                        new Dictionary<string, object>
                        {
                            ["internal-key"] = "internal-value-secret"
                        },
                        new[] { "ready", "internal-secret-tag" })
                });

            await HealthResponseWriter.Write(context, report);

            var body = ReadBody(context);
            Assert.Contains("database", body, StringComparison.Ordinal);
            Assert.DoesNotContain("internal-description-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("internal-value-secret", body, StringComparison.Ordinal);
            Assert.DoesNotContain("internal-secret-tag", body, StringComparison.Ordinal);
            Assert.DoesNotContain("internal-key", body, StringComparison.Ordinal);
        }

        [Fact]
        public async Task WriterRejectsNullContext()
        {
            var report = CreateReport(
                HealthStatus.Healthy,
                new Dictionary<string, HealthReportEntry>());

            await Assert.ThrowsAsync<ArgumentNullException>(() =>
                HealthResponseWriter.Write(null!, report));
        }

        [Fact]
        public async Task WriterRejectsNullReport()
        {
            var context = CreateContext();

            await Assert.ThrowsAsync<ArgumentNullException>(() =>
                HealthResponseWriter.Write(context, null!));
        }

        private static DefaultHttpContext CreateContext()
        {
            var context = new DefaultHttpContext();
            context.Response.Body = new MemoryStream();
            return context;
        }

        private static HealthReport CreateReport(
            HealthStatus status,
            IReadOnlyDictionary<string, HealthReportEntry> entries) =>
            new HealthReport(entries, TimeSpan.FromMilliseconds(7));

        private static HealthReportEntry Entry(HealthStatus status, int durationMs) =>
            new HealthReportEntry(
                status,
                description: "server-side-only-description",
                duration: TimeSpan.FromMilliseconds(durationMs),
                exception: null,
                data: new Dictionary<string, object>());

        private static JsonDocument ReadJson(DefaultHttpContext context)
        {
            context.Response.Body.Position = 0;
            return JsonDocument.Parse(context.Response.Body);
        }

        private static string ReadBody(DefaultHttpContext context)
        {
            var position = context.Response.Body.Position;
            context.Response.Body.Position = 0;
            using var reader = new StreamReader(
                context.Response.Body,
                Encoding.UTF8,
                detectEncodingFromByteOrderMarks: false,
                bufferSize: 1024,
                leaveOpen: true);
            var body = reader.ReadToEnd();
            context.Response.Body.Position = position;
            return body;
        }
    }
}
