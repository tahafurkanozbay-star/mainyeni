using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using SystemNetIPNetwork = System.Net.IPNetwork;

namespace Api.Core.Platform
{
    /// <summary>
    /// Builds the ASP.NET Core forwarded-header policy from an explicit trust topology. The runtime
    /// keeps framework loopback defaults and only adds administrator-configured proxy addresses or
    /// CIDR networks. There is intentionally no "trust all" switch because forwarded client IP and
    /// scheme are security inputs for rate limiting, HTTPS behavior and diagnostics.
    /// </summary>
    public static class ForwardedHeaderTrustPolicy
    {
        public const int MaxTrustedProxyEntries = 64;
        public const int MaxTrustedNetworkEntries = 64;

        private const string SectionPath = ApiPlatformOptions.SectionName + ":ForwardedHeaders";
        private const string KnownProxiesPath = SectionPath + ":KnownProxies";
        private const string KnownNetworksPath = SectionPath + ":KnownIPNetworks";
        private const string RequireSymmetryPath = SectionPath + ":RequireHeaderSymmetry";

        public static ForwardedHeadersOptions Build(
            ApiPlatformOptions.ForwardedHeaderOptions platformOptions,
            IConfiguration configuration)
        {
            if (platformOptions == null)
            {
                throw new ArgumentNullException(nameof(platformOptions));
            }
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }

            var failures = new List<string>();
            var proxies = ParseProxies(configuration, failures);
            var networks = ParseNetworks(configuration, failures);
            var requireSymmetry = ParseRequireHeaderSymmetry(configuration, failures);

            if (failures.Count != 0)
            {
                throw new OptionsValidationException(
                    Options.DefaultName,
                    typeof(ApiPlatformOptions.ForwardedHeaderOptions),
                    failures);
            }

            var result = new ForwardedHeadersOptions
            {
                ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
                ForwardLimit = platformOptions.ForwardLimit,
                RequireHeaderSymmetry = requireSymmetry
            };

            foreach (var proxy in proxies)
            {
                if (!result.KnownProxies.Any(existing => existing.Equals(proxy)))
                {
                    result.KnownProxies.Add(proxy);
                }
            }

            foreach (var network in networks)
            {
                if (!result.KnownIPNetworks.Contains(network))
                {
                    result.KnownIPNetworks.Add(network);
                }
            }

            return result;
        }

        internal static IReadOnlyList<IPAddress> ParseProxies(
            IConfiguration configuration,
            ICollection<string> failures)
        {
            var values = ReadValues(configuration, KnownProxiesPath, failures);
            if (values.Count > MaxTrustedProxyEntries)
            {
                failures.Add(
                    $"Platform:ForwardedHeaders:KnownProxies cannot contain more than {MaxTrustedProxyEntries} entries.");
                return Array.Empty<IPAddress>();
            }

            var parsed = new List<IPAddress>(values.Count);
            foreach (var value in values)
            {
                if (!IPAddress.TryParse(value, out var address) || address == null)
                {
                    failures.Add($"Platform:ForwardedHeaders:KnownProxies contains invalid IP address '{value}'.");
                    continue;
                }

                if (IsUnspecifiedAddress(address))
                {
                    failures.Add(
                        $"Platform:ForwardedHeaders:KnownProxies cannot trust unspecified address '{value}'.");
                    continue;
                }

                if (!parsed.Any(existing => existing.Equals(address)))
                {
                    parsed.Add(address);
                }
            }

            return parsed;
        }

        internal static IReadOnlyList<SystemNetIPNetwork> ParseNetworks(
            IConfiguration configuration,
            ICollection<string> failures)
        {
            var values = ReadValues(configuration, KnownNetworksPath, failures);
            if (values.Count > MaxTrustedNetworkEntries)
            {
                failures.Add(
                    $"Platform:ForwardedHeaders:KnownIPNetworks cannot contain more than {MaxTrustedNetworkEntries} entries.");
                return Array.Empty<SystemNetIPNetwork>();
            }

            var parsed = new List<SystemNetIPNetwork>(values.Count);
            foreach (var value in values)
            {
                if (!SystemNetIPNetwork.TryParse(value, out var network))
                {
                    failures.Add($"Platform:ForwardedHeaders:KnownIPNetworks contains invalid CIDR '{value}'.");
                    continue;
                }

                if (network.PrefixLength == 0)
                {
                    failures.Add(
                        $"Platform:ForwardedHeaders:KnownIPNetworks cannot trust an all-addresses network '{value}'.");
                    continue;
                }

                if (!parsed.Contains(network))
                {
                    parsed.Add(network);
                }
            }

            return parsed;
        }

        internal static bool ParseRequireHeaderSymmetry(
            IConfiguration configuration,
            ICollection<string> failures)
        {
            var raw = configuration[RequireSymmetryPath];
            if (string.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            if (bool.TryParse(raw.Trim(), out var parsed))
            {
                return parsed;
            }

            failures.Add("Platform:ForwardedHeaders:RequireHeaderSymmetry must be true or false.");
            return false;
        }

        private static List<string> ReadValues(
            IConfiguration configuration,
            string path,
            ICollection<string> failures)
        {
            var section = configuration.GetSection(path);
            var result = new List<string>();

            if (!string.IsNullOrWhiteSpace(section.Value))
            {
                AddValue(section.Value, path, result, failures);
            }

            foreach (var child in section.GetChildren())
            {
                AddValue(child.Value, path, result, failures);
            }

            return result;
        }

        private static void AddValue(
            string value,
            string path,
            ICollection<string> result,
            ICollection<string> failures)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                failures.Add($"{path} cannot contain blank entries.");
                return;
            }

            // Validate the unmodified configuration value before trimming. Trimming first would
            // silently turn a trailing CR/LF into a valid proxy/network token and weaken the
            // trust-boundary parser's fail-closed behavior.
            if (value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                failures.Add($"{path} cannot contain newline characters.");
                return;
            }

            result.Add(value.Trim());
        }

        private static bool IsUnspecifiedAddress(IPAddress address)
        {
            return address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any);
        }
    }
}
