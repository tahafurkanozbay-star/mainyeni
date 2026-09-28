using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using System;
using System.Net;

namespace Api.Core.Platform
{
    /// <summary>
    /// Converts validated platform proxy trust settings into the ASP.NET Core forwarded-header
    /// policy. The framework's loopback trust defaults are deliberately preserved; configured
    /// entries only augment them, so an empty allowlist can never become an implicit trust-all.
    /// </summary>
    internal static class ApiForwardedHeadersPolicy
    {
        internal const int MaxTrustedForwarderEntries = 64;

        internal static ForwardedHeadersOptions Create(
            ApiPlatformOptions.ForwardedHeaderOptions options)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            var policy = new ForwardedHeadersOptions
            {
                ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
                ForwardLimit = options.ForwardLimit,
                RequireHeaderSymmetry = options.RequireHeaderSymmetry
            };

            var proxyCount = options.KnownProxies?.Count ?? 0;
            var networkCount = options.KnownIPNetworks?.Count ?? 0;
            if (proxyCount + networkCount > MaxTrustedForwarderEntries)
            {
                throw new InvalidOperationException(
                    $"Forwarded-header trust entries cannot exceed {MaxTrustedForwarderEntries}.");
            }

            if (options.KnownProxies != null)
            {
                foreach (var rawProxy in options.KnownProxies)
                {
                    if (!IPAddress.TryParse(rawProxy?.Trim(), out var proxy) ||
                        IPAddress.Any.Equals(proxy) ||
                        IPAddress.IPv6Any.Equals(proxy))
                    {
                        throw new InvalidOperationException(
                            $"Invalid trusted forwarded-header proxy '{rawProxy ?? "<null>"}'.");
                    }

                    if (!policy.KnownProxies.Contains(proxy))
                    {
                        policy.KnownProxies.Add(proxy);
                    }
                }
            }

            if (options.KnownIPNetworks != null)
            {
                foreach (var rawNetwork in options.KnownIPNetworks)
                {
                    if (!IPNetwork.TryParse(rawNetwork?.Trim(), out var network) ||
                        network.PrefixLength == 0)
                    {
                        throw new InvalidOperationException(
                            $"Invalid trusted forwarded-header network '{rawNetwork ?? "<null>"}'.");
                    }

                    if (!policy.KnownIPNetworks.Contains(network))
                    {
                        policy.KnownIPNetworks.Add(network);
                    }
                }
            }

            return policy;
        }
    }
}
