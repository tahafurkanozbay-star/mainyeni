#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RepositoryModernizationPolicyTests
{
    private static readonly Lazy<string> RepositoryRoot = new(FindRepositoryRoot);

    [Fact]
    public void BuildPolicy_PinsNet10AndCSharp14()
    {
        var document = LoadXml("Directory.Build.props");
        var properties = document
            .Descendants("PropertyGroup")
            .Elements()
            .GroupBy(element => element.Name.LocalName, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.Ordinal);

        Assert.Equal("net10.0", properties["TargetFramework"]);
        Assert.Equal("14.0", properties["LangVersion"]);
        Assert.Equal("true", properties["EnableNETAnalyzers"]);
        Assert.Equal("latest", properties["AnalysisLevel"]);
        Assert.Equal("true", properties["Deterministic"]);
        Assert.Equal("all", properties["RestoreAuditMode"]);
        Assert.Equal("moderate", properties["RestoreAuditLevel"]);
    }

    [Fact]
    public void GlobalJson_PinsSupportedDotNet10SdkWithoutPrerelease()
    {
        using var stream = File.OpenRead(Path.Combine(RepositoryRoot.Value, "global.json"));
        using var document = JsonDocument.Parse(stream);

        var sdk = document.RootElement.GetProperty("sdk");
        Assert.Equal("10.0.401", sdk.GetProperty("version").GetString());
        Assert.Equal("latestPatch", sdk.GetProperty("rollForward").GetString());
        Assert.False(sdk.GetProperty("allowPrerelease").GetBoolean());
    }

    [Fact]
    public void CentralPackageManagement_IsEnabledAndHasUniquePackageIds()
    {
        var document = LoadXml("Directory.Packages.props");
        var enabled = document
            .Descendants("ManagePackageVersionsCentrally")
            .Select(element => element.Value)
            .LastOrDefault();

        Assert.Equal("true", enabled);

        var packageIds = document
            .Descendants("PackageVersion")
            .Select(element => (string?)element.Attribute("Include"))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Cast<string>()
            .ToArray();

        Assert.NotEmpty(packageIds);
        Assert.Equal(
            packageIds.Length,
            packageIds.Distinct(StringComparer.OrdinalIgnoreCase).Count());
    }

    [Fact]
    public void ProjectPackageReferences_DoNotDeclareLocalVersionsOrOverrides()
    {
        foreach (var projectPath in EnumerateSolutionProjects())
        {
            var document = XDocument.Load(projectPath);
            foreach (var packageReference in document.Descendants("PackageReference"))
            {
                Assert.Null(packageReference.Attribute("Version"));
                Assert.Null(packageReference.Attribute("VersionOverride"));
                Assert.Empty(packageReference.Elements("Version"));
                Assert.Empty(packageReference.Elements("VersionOverride"));
            }
        }
    }

    [Fact]
    public void EveryProjectPackageReference_HasOneCentralVersion()
    {
        var centralDocument = LoadXml("Directory.Packages.props");
        var centralPackages = centralDocument
            .Descendants("PackageVersion")
            .Select(element => new
            {
                Id = (string?)element.Attribute("Include"),
                Version = (string?)element.Attribute("Version")
            })
            .Where(item => !string.IsNullOrWhiteSpace(item.Id))
            .ToDictionary(
                item => item.Id!,
                item => item.Version,
                StringComparer.OrdinalIgnoreCase);

        foreach (var projectPath in EnumerateSolutionProjects())
        {
            var document = XDocument.Load(projectPath);
            foreach (var packageReference in document.Descendants("PackageReference"))
            {
                var packageId = (string?)packageReference.Attribute("Include");
                Assert.False(string.IsNullOrWhiteSpace(packageId));
                Assert.True(
                    centralPackages.TryGetValue(packageId!, out var version),
                    $"{Path.GetRelativePath(RepositoryRoot.Value, projectPath)} references '{packageId}' without a central PackageVersion.");
                Assert.False(
                    string.IsNullOrWhiteSpace(version),
                    $"Central package '{packageId}' must have a non-empty version.");
            }
        }
    }

    [Fact]
    public void SolutionProjectList_IsFullyCoveredByModernizationPolicy()
    {
        var solutionText = File.ReadAllText(Path.Combine(RepositoryRoot.Value, "CityWorks.NetCore.sln"));
        var projectPaths = EnumerateSolutionProjects()
            .Select(path => Path.GetRelativePath(RepositoryRoot.Value, path).Replace('/', '\\'))
            .ToArray();

        Assert.Equal(6, projectPaths.Length);
        foreach (var projectPath in projectPaths)
        {
            Assert.Contains(projectPath, solutionText, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static XDocument LoadXml(string relativePath)
    {
        return XDocument.Load(Path.Combine(RepositoryRoot.Value, relativePath));
    }

    private static string[] EnumerateSolutionProjects()
    {
        var root = RepositoryRoot.Value;
        return new[]
        {
            "Business/Business.csproj",
            "Toolbox/Toolbox.csproj",
            "Api.Core/Api.Core.csproj",
            "Api.Admin/Api.Admin.csproj",
            "Api.User/Api.User.csproj",
            "tests/Platform.Security.Tests/Platform.Security.Tests.csproj"
        }
        .Select(relativePath => Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)))
        .ToArray();
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "CityWorks.NetCore.sln")) &&
                File.Exists(Path.Combine(directory.FullName, "Directory.Build.props")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate the repository root containing CityWorks.NetCore.sln and Directory.Build.props.");
    }
}
