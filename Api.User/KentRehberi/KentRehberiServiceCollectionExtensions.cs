using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Linq;

namespace Api.User.KentRehberi;

public static class KentRehberiServiceCollectionExtensions
{
    public static IServiceCollection AddKentRehberiData(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var options = new KentRehberiOptions();
        configuration.GetSection(KentRehberiOptions.SectionName).Bind(options);

        var failures = options.Validate();
        if (failures.Count > 0)
        {
            throw new InvalidOperationException(
                "Invalid KentRehberiData configuration: " +
                string.Join(" ", failures.Distinct(StringComparer.Ordinal)));
        }

        services.AddSingleton(options);
        services.AddSingleton<KentRehberiConnectionFactory>();
        services.AddScoped<IKentRehberiRepository, KentRehberiRepository>();

        return services;
    }
}
