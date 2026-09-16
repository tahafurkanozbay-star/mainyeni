using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace Platform.Security.Tests;

public sealed class RepositorySecurityContractTests
{
    private static readonly Lazy<string> RepositoryRoot = new(FindRepositoryRoot);

    [Theory]
    [InlineData("Api.Admin/appsettings.json")]
    [InlineData("Api.User/appsettings.json")]
    public void AppSettings_AreValidJson_AndDoNotContainTrackedDatabaseCredentials(string relativePath)
    {
        var text = Read(relativePath);
        using var document = JsonDocument.Parse(text);

        Assert.DoesNotContain("Password=", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("User ID=", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Server=", text, StringComparison.OrdinalIgnoreCase);

        var root = document.RootElement;
        Assert.True(root.TryGetProperty("ConnectionStrings", out var connectionStrings));
        Assert.True(connectionStrings.TryGetProperty("Primary", out var primary));
        Assert.True(string.IsNullOrWhiteSpace(primary.GetString()));
    }

    [Fact]
    public void JwtSigningKey_IsLoadedFromServerEnvironment_NotSourceLiteral()
    {
        var jwtUtils = Read("Toolbox/Security/Jwt/JwtUtils.cs");

        Assert.Contains("KENT_REHBERI_JWT_SIGNING_KEY", jwtUtils, StringComparison.Ordinal);
        Assert.Contains("Environment.GetEnvironmentVariable", jwtUtils, StringComparison.Ordinal);
        Assert.DoesNotContain("private static string Secret", jwtUtils, StringComparison.Ordinal);
        Assert.DoesNotContain("private const string Secret", jwtUtils, StringComparison.Ordinal);
        Assert.DoesNotContain("return true;\n                //TODO", jwtUtils, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyUserApiClientSecret_IsNotEmbeddedOrSynthesizedInBrowserSource()
    {
        var apiConfiguration = Read("Api.User/Controllers/Base/ApiConfiguration.cs");
        var authBusiness = Read("Webclient.app/src/Business/AuthBusiness.js");
        var env = Read("Webclient.app/.env");

        Assert.DoesNotContain("const string SECRET", apiConfiguration, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("REACT_APP_CLIENT_KEY", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("CryptoJS", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("'Authorization'", authBusiness, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CryptoJS.AES.encrypt", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotMatch(new Regex(@"REACT_APP_CLIENT_KEY\s*=", RegexOptions.IgnoreCase), env);
    }

    [Fact]
    public void AdminSessionStorage_DoesNotPersistBearerTokenAcrossBrowserSessions()
    {
        var authBusiness = Read("Webclient.admin/src/Business/AuthBusiness.js");
        var constants = Read("Webclient.admin/src/Core/Constants.js");

        Assert.Contains("sessionStorage.getItem", authBusiness, StringComparison.Ordinal);
        Assert.Contains("sessionStorage.setItem", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("localStorage.getItem", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("localStorage.setItem", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("CryptoJS.AES", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("Session.Pk", authBusiness, StringComparison.Ordinal);
        Assert.DoesNotContain("Pk:", constants, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Api.Admin/Program.cs")]
    [InlineData("Api.User/Program.cs")]
    public void ApiCorsPolicies_DoNotAllowArbitraryOrigins(string relativePath)
    {
        var program = Read(relativePath);

        Assert.DoesNotContain("AllowAnyOrigin", program, StringComparison.Ordinal);
        Assert.DoesNotContain("Access-Control-Allow-Origin\", \"*", program, StringComparison.Ordinal);
        Assert.Contains("AddKentRehberiApiPlatform", program, StringComparison.Ordinal);
        Assert.Contains("Cors:AllowedOrigins", program, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Api.Admin/Program.cs")]
    [InlineData("Api.User/Program.cs")]
    public void Kestrel_DoesNotUseLegacyThirtyMinuteKeepAlive(string relativePath)
    {
        var program = Read(relativePath);

        Assert.DoesNotContain("TimeSpan.FromMinutes(30)", program, StringComparison.Ordinal);
        Assert.DoesNotContain("99999999", program, StringComparison.Ordinal);
        Assert.Contains("AddServerHeader = false", program, StringComparison.Ordinal);
        Assert.Contains("WebApplication.CreateBuilder", program, StringComparison.Ordinal);
        Assert.DoesNotContain("UseStartup<", program, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyStartupHostingFiles_AreRemoved()
    {
        Assert.False(File.Exists(Path.Combine(RepositoryRoot.Value, "Api.Admin", "Startup.cs")));
        Assert.False(File.Exists(Path.Combine(RepositoryRoot.Value, "Api.User", "Startup.cs")));
    }

    [Fact]
    public void LdapIntegration_IsFailClosedWithoutExplicitServerConfiguration()
    {
        var configuration = Read("Business/Core/Common/Configuration.cs");
        var authOperations = Read("Business/Core/Operations/Auth/AuthOperations.cs");

        Assert.DoesNotContain("manisa.bel.tr", configuration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("KENT_REHBERI_LDAP_DOMAIN", configuration, StringComparison.Ordinal);
        Assert.Contains("KENT_REHBERI_LDAP_SERVER", configuration, StringComparison.Ordinal);
        Assert.Contains("!string.IsNullOrWhiteSpace(Configuration.LDAP_SERVER)", authOperations, StringComparison.Ordinal);
    }

    [Fact]
    public void BackendTargets_AreCentralizedOnNet10AndCSharp14_WithoutLegacyAspNetPackagesOrPomelo()
    {
        var props = Read("Directory.Build.props");
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", props, StringComparison.Ordinal);
        Assert.Contains("<LangVersion>14.0</LangVersion>", props, StringComparison.Ordinal);

        var projects = new[]
        {
            "Api.Admin/Api.Admin.csproj",
            "Api.Core/Api.Core.csproj",
            "Api.User/Api.User.csproj",
            "Business/Business.csproj",
            "Toolbox/Toolbox.csproj"
        };

        foreach (var project in projects)
        {
            var content = Read(project);
            Assert.DoesNotContain("<TargetFramework>net6.0</TargetFramework>", content, StringComparison.Ordinal);
            Assert.DoesNotContain("Microsoft.AspNetCore.Cors", content, StringComparison.Ordinal);
            Assert.DoesNotContain("Microsoft.AspNetCore.Authentication\" Version=\"2.", content, StringComparison.Ordinal);
            Assert.DoesNotContain("Microsoft.AspNetCore.Http.Features\" Version=\"5.", content, StringComparison.Ordinal);
            Assert.DoesNotContain("Pomelo.EntityFrameworkCore.MySql", content, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void DotNet10TestRunner_IsPinnedToMicrosoftTestingPlatform()
    {
        var text = Read("global.json");
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;

        Assert.Equal("10.0.401", root.GetProperty("sdk").GetProperty("version").GetString());
        Assert.Equal("latestPatch", root.GetProperty("sdk").GetProperty("rollForward").GetString());
        Assert.False(root.GetProperty("sdk").GetProperty("allowPrerelease").GetBoolean());
        Assert.Equal("Microsoft.Testing.Platform", root.GetProperty("test").GetProperty("runner").GetString());
    }

    [Fact]
    public void BackendCi_RestoresAuditsBuildsTestsAndPublishesOnPinnedNet10Sdk()
    {
        var workflow = Read(".github/workflows/platform-backend-validation.yml");

        Assert.Contains("global-json-file: global.json", workflow, StringComparison.Ordinal);
        Assert.Contains("dotnet restore CityWorks.NetCore.sln", workflow, StringComparison.Ordinal);
        Assert.Contains("--vulnerable --include-transitive", workflow, StringComparison.Ordinal);
        Assert.Contains("dotnet build CityWorks.NetCore.sln --configuration Release --no-restore", workflow, StringComparison.Ordinal);
        Assert.Contains("Run xUnit v3 tests through Microsoft.Testing.Platform", workflow, StringComparison.Ordinal);
        Assert.Contains("dotnet run --project tests/Platform.Security.Tests/Platform.Security.Tests.csproj --configuration Release --no-build --no-restore", workflow, StringComparison.Ordinal);
        Assert.DoesNotContain("dotnet test CityWorks.NetCore.sln", workflow, StringComparison.Ordinal);
        Assert.Contains("dotnet publish Api.User/Api.User.csproj", workflow, StringComparison.Ordinal);
        Assert.Contains("dotnet publish Api.Admin/Api.Admin.csproj", workflow, StringComparison.Ordinal);
    }

    [Fact]
    public void PasswordWrites_UseVersionedPbkdf2_WhileLegacySha1IsCompatibilityOnly()
    {
        var passwordUtils = Read("Toolbox/Security/Password/PasswordUtils.cs");
        var authPasswords = Read("Business/Core/Operations/Auth/AuthPasswordOperations.cs");
        var auth = Read("Business/Core/Operations/Auth/AuthOperations.cs");

        Assert.Contains("pbkdf2-sha256", passwordUtils, StringComparison.Ordinal);
        Assert.Contains("600_000", passwordUtils, StringComparison.Ordinal);
        Assert.Contains("CryptographicOperations.FixedTimeEquals", passwordUtils, StringComparison.Ordinal);
        Assert.Contains("legacy SHA-1 compatibility", authPasswords, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("HashPassword(viewModel.NewPassword)", auth, StringComparison.Ordinal);
        Assert.Contains("needsRehash", auth, StringComparison.Ordinal);
    }

    [Fact]
    public void DatabaseModel_DoesNotSeedPrivilegedAccountsOrCredentials()
    {
        var context = Read("Business/Core/Context/BusinessContext.cs");

        Assert.DoesNotContain("HasData", context, StringComparison.Ordinal);
        Assert.DoesNotContain("UserSettings_DefaultPassword", context, StringComparison.Ordinal);
        Assert.DoesNotContain("IsSuperUser = true", context, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicConfigurationEndpoint_IsRestrictedToSingleServerOwnedGisBootstrapKey()
    {
        var controller = Read("Api.User/Controllers/Core/AppSettingsController.cs");

        Assert.Contains("private const string PublicMapConfigKey = \"GisMapConfig\"", controller, StringComparison.Ordinal);
        Assert.Contains("string.Equals(key?.Trim(), PublicMapConfigKey", controller, StringComparison.Ordinal);
        Assert.Contains("operations.GetConfig(PublicMapConfigKey)", controller, StringComparison.Ordinal);
        Assert.DoesNotContain("operations.GetConfig(key)", controller, StringComparison.Ordinal);
    }

    [Fact]
    public void ApplicationApiClient_DefaultsToSameOriginThroughCentralRuntimeConfiguration()
    {
        var env = Read("Webclient.app/.env");
        var appConfig = Read("Webclient.app/src/Core/AppConfig.js");
        var runtimeConfig = Read("Webclient.app/src/platform/config/runtimeConfig.js");
        var endpointPolicy = Read("Webclient.app/src/platform/network/endpointPolicy.js");

        Assert.Contains("REACT_APP_API_URL=/api", env, StringComparison.Ordinal);
        Assert.Contains("const DEFAULT_API_BASE_URL = '/api'", runtimeConfig, StringComparison.Ordinal);
        Assert.Contains("BaseUrl: runtimeConfig.apiBaseUrl", appConfig, StringComparison.Ordinal);
        Assert.Contains("isSameOriginPath", endpointPolicy, StringComparison.Ordinal);
        Assert.Contains("CROSS_ORIGIN_BLOCKED", endpointPolicy, StringComparison.Ordinal);
        Assert.Contains("trimmed.startsWith('/')", endpointPolicy, StringComparison.Ordinal);
        Assert.Contains("!trimmed.startsWith('//')", endpointPolicy, StringComparison.Ordinal);
    }

    private static string Read(string relativePath)
    {
        var path = Path.Combine(RepositoryRoot.Value, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(path), $"Expected repository file was not found: {relativePath} ({path})");
        return File.ReadAllText(path);
    }

    private static string FindRepositoryRoot()
    {
        var candidates = new List<string>
        {
            Directory.GetCurrentDirectory(),
            AppContext.BaseDirectory
        };

        foreach (var candidate in candidates.Where(x => !string.IsNullOrWhiteSpace(x)))
        {
            var directory = new DirectoryInfo(candidate);
            while (directory != null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "KENT_REHBERI_AGENT_RULES.md")) &&
                    File.Exists(Path.Combine(directory.FullName, "CityWorks.NetCore.sln")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        throw new DirectoryNotFoundException("Could not locate the Kent Rehberi repository root for contract tests.");
    }
}
