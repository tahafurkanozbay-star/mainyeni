using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using System;

namespace Api.Core.Platform.Transport
{
    /// <summary>
    /// Central transport policy for both public and administrative APIs. Kestrel defaults are
    /// generally secure, but explicit repository-owned bounds make release behavior deterministic
    /// and prevent one host from drifting toward larger request metadata or slower header attacks.
    /// </summary>
    public static class ApiTransportPolicy
    {
        public static void Apply(
            KestrelServerOptions serverOptions,
            ApiPlatformOptions.TransportOptions options)
        {
            if (serverOptions == null)
            {
                throw new ArgumentNullException(nameof(serverOptions));
            }
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            serverOptions.AddServerHeader = false;
            serverOptions.AllowSynchronousIO = false;

            var limits = serverOptions.Limits;
            limits.KeepAliveTimeout = TimeSpan.FromSeconds(options.KeepAliveTimeoutSeconds);
            limits.RequestHeadersTimeout = TimeSpan.FromSeconds(options.RequestHeadersTimeoutSeconds);
            limits.MaxRequestLineSize = options.MaxRequestLineSizeBytes;
            limits.MaxRequestHeadersTotalSize = options.MaxRequestHeadersTotalSizeBytes;
            limits.MaxRequestHeaderCount = options.MaxRequestHeaderCount;
            limits.MaxRequestBodySize = options.MaxRequestBodyBytes;
        }

        public static IWebHostBuilder ConfigureKentRehberiTransport(
            this IWebHostBuilder webHost,
            IConfiguration configuration)
        {
            if (webHost == null)
            {
                throw new ArgumentNullException(nameof(webHost));
            }
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }

            var platformOptions = ApiPlatformConfigurationResolver.ResolveOptions(configuration);
            var validation = new ApiPlatformOptionsValidator()
                .Validate(Options.DefaultName, platformOptions);
            if (validation.Failed)
            {
                throw new OptionsValidationException(
                    Options.DefaultName,
                    typeof(ApiPlatformOptions),
                    validation.Failures);
            }

            return webHost.ConfigureKestrel(
                serverOptions => Apply(serverOptions, platformOptions.Transport));
        }
    }
}
