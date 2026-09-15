using Business.Core.Context;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Security.Cryptography;

namespace Platform.Security.Tests;

internal sealed class TestEnvironment : IDisposable
{
    private static readonly string[] ManagedVariables =
    {
        "KENT_REHBERI_JWT_SIGNING_KEY",
        "KENT_REHBERI_JWT_ISSUER",
        "KENT_REHBERI_JWT_AUDIENCE",
        "KENT_REHBERI_LDAP_DOMAIN",
        "KENT_REHBERI_EMAIL_USER",
        "KENT_REHBERI_EMAIL_PASSWORD",
        "KENT_REHBERI_EMAIL_SERVER",
        "KENT_REHBERI_EMAIL_PORT",
        "KENT_REHBERI_DB_SCHEMA",
        "KENT_REHBERI_DEFAULT_USER_PASSWORD"
    };

    private readonly Dictionary<string, string?> originalValues = new(StringComparer.Ordinal);
    private bool disposed;

    public TestEnvironment()
    {
        foreach (var variable in ManagedVariables)
        {
            originalValues[variable] = Environment.GetEnvironmentVariable(variable);
        }

        SetJwtConfiguration();
        Environment.SetEnvironmentVariable("KENT_REHBERI_LDAP_DOMAIN", null);
    }

    public string SigningKeyBase64 => Environment.GetEnvironmentVariable("KENT_REHBERI_JWT_SIGNING_KEY")!;
    public string Issuer => Environment.GetEnvironmentVariable("KENT_REHBERI_JWT_ISSUER")!;
    public string Audience => Environment.GetEnvironmentVariable("KENT_REHBERI_JWT_AUDIENCE")!;

    public void SetJwtConfiguration(
        string issuer = "kent-rehberi-tests",
        string audience = "kent-rehberi-tests-admin",
        byte[]? signingKey = null)
    {
        var key = signingKey ?? RandomNumberGenerator.GetBytes(64);
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_SIGNING_KEY", Convert.ToBase64String(key));
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_ISSUER", issuer);
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_AUDIENCE", audience);
    }

    public void ClearJwtSigningKey()
    {
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_SIGNING_KEY", null);
    }

    public void SetJwtSigningKeyRaw(string? value)
    {
        Environment.SetEnvironmentVariable("KENT_REHBERI_JWT_SIGNING_KEY", value);
    }

    public BusinessContext CreateDbContext(string? databaseName = null)
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase(databaseName ?? Guid.NewGuid().ToString("N"))
            .EnableDetailedErrors()
            .Options;

        return new BusinessContext(options);
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        foreach (var entry in originalValues)
        {
            Environment.SetEnvironmentVariable(entry.Key, entry.Value);
        }

        disposed = true;
    }
}
