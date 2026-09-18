using Microsoft.Extensions.Configuration;
using Npgsql;
using System;

namespace Api.User.KentRehberi;

public sealed class KentRehberiConnectionFactory
{
    private readonly string? connectionString;

    public KentRehberiConnectionFactory(
        IConfiguration configuration,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(options);

        if (!options.Enabled)
        {
            return;
        }

        var configured = configuration
            .GetConnectionString(KentRehberiOptions.ConnectionStringName)
            ?.Trim();

        if (string.IsNullOrWhiteSpace(configured))
        {
            return;
        }

        var builder = new NpgsqlConnectionStringBuilder(configured)
        {
            ApplicationName = "ankara-kent-rehberi-user-api",
            Timeout = options.ConnectionTimeoutSeconds,
            CommandTimeout = options.CommandTimeoutSeconds,
            Pooling = true,
            MaxPoolSize = options.MaxPoolSize,
            IncludeErrorDetail = false
        };

        connectionString = builder.ConnectionString;
    }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(connectionString);

    public NpgsqlConnection CreateConnection()
    {
        if (!IsConfigured)
        {
            throw new KentRehberiDataUnavailableException(
                "Kent Rehberi data source is not configured.");
        }

        return new NpgsqlConnection(connectionString);
    }
}

public sealed class KentRehberiDataUnavailableException : InvalidOperationException
{
    public KentRehberiDataUnavailableException(string message)
        : base(message)
    {
    }
}
