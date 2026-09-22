using Api.User.KentRehberi;
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiApiSecurityContractTests
{
    private static readonly Lazy<string> RepositoryRoot = new(FindRepositoryRoot);

    [Fact]
    public void TrackedConfiguration_ContainsNoKentRehberiDatabaseSecret()
    {
        var appsettings = Read("Api.User/appsettings.json");
        using var document = JsonDocument.Parse(appsettings);

        var connectionStrings = document.RootElement
            .GetProperty("ConnectionStrings");

        Assert.Equal(
            string.Empty,
            connectionStrings.GetProperty("KentRehberi").GetString());

        Assert.DoesNotContain("192.168.101.161", appsettings, StringComparison.Ordinal);
        Assert.DoesNotContain("Password=", appsettings, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("User ID=", appsettings, StringComparison.OrdinalIgnoreCase);

        var data = document.RootElement
            .GetProperty("KentRehberiData");

        Assert.Equal(
            "PlanAski",
            data.GetProperty("Source").GetString());
        Assert.Equal(
            KentRehberiOptions.OfficialPlanAskiBaseUri,
            data.GetProperty("PlanAskiBaseUri").GetString());
        Assert.Equal(
            0,
            data.GetProperty("PlanAskiMinTur").GetInt32());
        Assert.Equal(
            42,
            data.GetProperty("PlanAskiMaxTur").GetInt32());
    }

    [Fact]
    public void PlanAskiSource_IsPinnedToOfficialHttpsEndpointAndBounded()
    {
        var source = Read(
            "Api.User/KentRehberi/KentRehberiPlanAskiSource.cs");
        var registration = Read(
            "Api.User/KentRehberi/KentRehberiServiceCollectionExtensions.cs");
        var options = Read(
            "Api.User/KentRehberi/KentRehberiOptions.cs");

        Assert.Contains(
            "planaski.ankara.bel.tr",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "/kentrehberiapi/api/kentrehberi",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "\"tur=\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "PlanAskiMaxResponseBytesPerType",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "PlanAskiMaxRecordsPerType",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "SemaphoreSlim",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "AllowAutoRedirect = false",
            registration,
            StringComparison.Ordinal);
        Assert.Contains(
            "Uri.UriSchemeHttps",
            options,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "DangerousAcceptAnyServerCertificateValidator",
            registration,
            StringComparison.Ordinal);
    }

    [Fact]
    public void PostgisFallback_UsesFixedServerOwnedTableAndParameterizedUserInput()
    {
        var source = Read("Api.User/KentRehberi/KentRehberiRepository.cs");

        Assert.Contains(
            "kent_rehberi.kent_rehberi_tumu_pggeom",
            source,
            StringComparison.Ordinal);
        Assert.Contains("AddWithValue", source, StringComparison.Ordinal);
        Assert.Contains("@ilce", source, StringComparison.Ordinal);
        Assert.Contains("@mahalle", source, StringComparison.Ordinal);
        Assert.Contains("@tur", source, StringComparison.Ordinal);
        Assert.Contains("@query", source, StringComparison.Ordinal);
        Assert.Contains("@minLongitude", source, StringComparison.Ordinal);
        Assert.Contains("@radiusMeters", source, StringComparison.Ordinal);
        Assert.DoesNotContain("gdb_geomattr_data", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("192.168.101.161", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicContract_DoesNotExposeBinaryGeodatabaseMetadata()
    {
        var contract = Read("Api.User/KentRehberi/KentRehberiContracts.cs");
        var controller = Read("Api.User/Controllers/KentRehberiController.cs");

        Assert.DoesNotContain("gdb_geomattr_data", contract, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("gdb_geomattr_data", controller, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("application/geo+json", controller, StringComparison.Ordinal);
        Assert.Contains("Status503ServiceUnavailable", controller, StringComparison.Ordinal);
    }

    [Fact]
    public void ConnectionFactory_FailsClosedAndDoesNotLogDatabaseTopology()
    {
        var source = Read(
            "Api.User/KentRehberi/KentRehberiConnectionFactory.cs");

        Assert.Contains("IsConfigured", source, StringComparison.Ordinal);
        Assert.Contains("KentRehberiDataUnavailableException", source, StringComparison.Ordinal);
        Assert.Contains("IncludeErrorDetail = false", source, StringComparison.Ordinal);
        Assert.DoesNotContain("192.168.101.161", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Console.Write", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadinessProbe_IsRegisteredAndUsesSafePublicHealthContract()
    {
        var registration = Read(
            "Api.User/KentRehberi/KentRehberiServiceCollectionExtensions.cs");
        var healthCheck = Read(
            "Api.User/KentRehberi/KentRehberiHealthCheck.cs");

        Assert.Contains("KentRehberiHealthCheck", registration, StringComparison.Ordinal);
        Assert.Contains("ApiPlatformDefaults.ReadinessTag", registration, StringComparison.Ordinal);
        Assert.Contains("HealthCheckResult.Unhealthy", healthCheck, StringComparison.Ordinal);
        Assert.DoesNotContain("Password=", healthCheck, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Host=", healthCheck, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PublicFailureLogging_DoesNotAttachDatabaseExceptionPayload()
    {
        var controller = Read("Api.User/Controllers/KentRehberiController.cs");

        Assert.Contains("{FailureType}", controller, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "logger.LogWarning(\n            exception,",
            controller,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ObjectIdCursor_IsFailClosedInTrackedConfiguration()
    {
        var appsettings = Read("Api.User/appsettings.json");
        using var document = JsonDocument.Parse(appsettings);

        var dataOptions = document.RootElement
            .GetProperty("KentRehberiData");

        Assert.False(
            dataOptions.GetProperty("ObjectIdCursorEnabled").GetBoolean());
    }

    [Fact]
    public void DatabaseRunbook_UsesColumnLevelReadOnlyGrant()
    {
        var sql = Read("database/kent-rehberi-api.sql");

        Assert.Contains(
            "GRANT SELECT (",
            sql,
            StringComparison.OrdinalIgnoreCase);
        Assert.Contains(
            "kent_rehberi.kent_rehberi_tumu_pggeom",
            sql,
            StringComparison.Ordinal);
        Assert.Contains(
            "TO kent_rehberi_select",
            sql,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "CREATE ROLE kent_rehberi_select",
            sql,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "gdb_geomattr_data",
            sql,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "GRANT INSERT",
            sql,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "GRANT UPDATE",
            sql,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "GRANT DELETE",
            sql,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LocalLaunchProfiles_AlignWithViteAndUseOfficialPlanAskiSource()
    {
        var launchSettings = Read(
            "Api.User/Properties/launchSettings.json");
        using var document =
            JsonDocument.Parse(
                launchSettings.TrimStart('﻿'));

        var root =
            document.RootElement;
        var iis =
            root.GetProperty("iisSettings")
                .GetProperty("iisExpress");

        Assert.Equal(
            "http://localhost:3002",
            iis.GetProperty("applicationUrl")
                .GetString());
        Assert.Equal(
            3003,
            iis.GetProperty("sslPort")
                .GetInt32());

        var profiles =
            root.GetProperty("profiles");
        var project =
            profiles.GetProperty("api.user");

        Assert.Equal(
            "https://localhost:3003;http://localhost:3002",
            project.GetProperty("applicationUrl")
                .GetString());

        foreach (var profileName in
                 new[]
                 {
                     "api.user",
                     "IIS Express"
                 })
        {
            var environment =
                profiles.GetProperty(profileName)
                    .GetProperty("environmentVariables");

            Assert.Equal(
                "PlanAski",
                environment
                    .GetProperty("KentRehberiData__Source")
                    .GetString());
            Assert.Equal(
                KentRehberiOptions.OfficialPlanAskiBaseUri,
                environment
                    .GetProperty("KentRehberiData__PlanAskiBaseUri")
                    .GetString());
            Assert.Equal(
                "0",
                environment
                    .GetProperty("KentRehberiData__PlanAskiMinTur")
                    .GetString());
            Assert.Equal(
                "42",
                environment
                    .GetProperty("KentRehberiData__PlanAskiMaxTur")
                    .GetString());
        }

        var vite =
            Read("Webclient.app/vite.config.ts");
        var localProxy =
            Read("Webclient.app/tooling/localApiProxy.ts");

        Assert.Contains(
            "target: apiProxyTarget",
            vite,
            StringComparison.Ordinal);
        Assert.Contains(
            "https://localhost:3003",
            localProxy,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "https://planaski.ankara.bel.tr",
            vite,
            StringComparison.Ordinal);
    }

    [Fact]
    public void DeploymentGuide_DoesNotTrackProvidedInternalHost()
    {
        var guide = Read("docs/kent-rehberi-postgis-api.md");

        Assert.DoesNotContain("192.168.101.161", guide, StringComparison.Ordinal);
        Assert.Contains(
            "ConnectionStrings__KentRehberi",
            guide,
            StringComparison.Ordinal);
        Assert.Contains(
            "planaski.ankara.bel.tr",
            guide,
            StringComparison.Ordinal);
        Assert.Contains(
            "tur=0",
            guide,
            StringComparison.Ordinal);
        Assert.Contains(
            "tur=42",
            guide,
            StringComparison.Ordinal);
        Assert.Contains("/api/kent-rehberi", guide, StringComparison.Ordinal);
    }

    private static string Read(string relativePath)
    {
        var path = Path.Combine(
            RepositoryRoot.Value,
            relativePath.Replace('/', Path.DirectorySeparatorChar));

        Assert.True(
            File.Exists(path),
            $"Expected repository file was not found: {relativePath} ({path})");

        return File.ReadAllText(path);
    }

    private static string FindRepositoryRoot()
    {
        var candidates = new List<string>
        {
            Directory.GetCurrentDirectory(),
            AppContext.BaseDirectory
        };

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate))
            {
                continue;
            }

            var directory = new DirectoryInfo(candidate);
            while (directory is not null)
            {
                if (File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "KENT_REHBERI_AGENT_RULES.md")) &&
                    File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "CityWorks.NetCore.sln")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        throw new DirectoryNotFoundException(
            "Could not locate the Kent Rehberi repository root.");
    }
}
