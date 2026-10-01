using Microsoft.AspNetCore.Http;
using System;
using System.Net;
using System.Net.Sockets;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

namespace Api.Core.Platform.ClientPartitioning
{
    /// <summary>
    /// Resolves the privacy-preserving client identity shared by rate limiting and request
    /// concurrency. The resolver consumes only the authenticated principal and the connection
    /// remote address after forwarded-header processing; arbitrary client headers are never used as
    /// an identity boundary.
    /// </summary>
    public static class ClientPartitionKeyResolver
    {
        private const string UnknownClientKey = "client:unknown";
        private const string UserPrefix = "user:";
        private const string AnonymousPrefix = "anon:";
        private const int MinimumIpv6PrefixLength = 48;
        private const int MaximumIpv6PrefixLength = 128;

        public static string ResolvePartitionKey(
            HttpContext context,
            ApiPlatformOptions options)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            var policy = options.ClientPartitioning
                ?? new ApiPlatformOptions.ClientPartitionOptions();

            if (policy.PartitionAuthenticatedUsers)
            {
                var stableSubject = ResolveStableAuthenticatedSubject(context.User);
                if (!string.IsNullOrWhiteSpace(stableSubject))
                {
                    return UserPrefix + HashIdentity("user\n" + stableSubject);
                }
            }

            return ResolveAnonymousPartition(
                context.Connection.RemoteIpAddress,
                policy.AnonymousIpv6PrefixLength);
        }

        public static string ResolveAnonymousPartition(
            IPAddress remoteAddress,
            int ipv6PrefixLength = 64)
        {
            if (remoteAddress == null)
            {
                return UnknownClientKey;
            }

            var normalized = NormalizeAddress(
                remoteAddress,
                ipv6PrefixLength,
                out var addressFamily,
                out var effectivePrefixLength);

            if (normalized == null)
            {
                return UnknownClientKey;
            }

            // Domain separation keeps anonymous and authenticated material in disjoint hash spaces
            // even if future identity sources happen to produce the same textual value.
            var material = addressFamily == AddressFamily.InterNetwork
                ? "ipv4\n" + normalized
                : "ipv6/" + effectivePrefixLength + "\n" + normalized;

            return AnonymousPrefix + HashIdentity(material);
        }

        internal static string ResolveStableAuthenticatedSubject(ClaimsPrincipal principal)
        {
            if (principal?.Identity?.IsAuthenticated != true)
            {
                return null;
            }

            var subject = principal.FindFirst("sub")?.Value;
            if (!string.IsNullOrWhiteSpace(subject))
            {
                return subject.Trim();
            }

            subject = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (!string.IsNullOrWhiteSpace(subject))
            {
                return subject.Trim();
            }

            // Mutable display/user names are intentionally not accepted as an abuse-control
            // identity. If authentication does not provide a stable subject, fall back to the
            // normalized anonymous network partition instead of allowing name churn to mint new
            // limiter/concurrency buckets.
            return null;
        }

        internal static string NormalizeAddress(
            IPAddress address,
            int ipv6PrefixLength,
            out AddressFamily addressFamily,
            out int effectivePrefixLength)
        {
            addressFamily = AddressFamily.Unspecified;
            effectivePrefixLength = 0;

            if (address == null)
            {
                return null;
            }

            if (address.IsIPv4MappedToIPv6)
            {
                address = address.MapToIPv4();
            }

            if (address.AddressFamily == AddressFamily.InterNetwork)
            {
                addressFamily = AddressFamily.InterNetwork;
                effectivePrefixLength = 32;
                return address.ToString();
            }

            if (address.AddressFamily != AddressFamily.InterNetworkV6)
            {
                return null;
            }

            effectivePrefixLength = Math.Clamp(
                ipv6PrefixLength,
                MinimumIpv6PrefixLength,
                MaximumIpv6PrefixLength);

            var bytes = address.GetAddressBytes();
            MaskIpv6HostBits(bytes, effectivePrefixLength);
            var networkAddress = new IPAddress(bytes);

            addressFamily = AddressFamily.InterNetworkV6;
            return networkAddress.ToString().ToLowerInvariant();
        }

        private static void MaskIpv6HostBits(byte[] bytes, int prefixLength)
        {
            var fullBytes = prefixLength / 8;
            var remainingBits = prefixLength % 8;

            if (remainingBits != 0 && fullBytes < bytes.Length)
            {
                var mask = (byte)(0xff << (8 - remainingBits));
                bytes[fullBytes] &= mask;
                fullBytes++;
            }

            for (var index = fullBytes; index < bytes.Length; index++)
            {
                bytes[index] = 0;
            }
        }

        private static string HashIdentity(string value)
        {
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
            // 96 bits is intentionally short enough for hot-path dictionary keys while providing
            // a collision probability far below the cardinality the process can retain.
            return Convert.ToHexString(bytes.AsSpan(0, 12)).ToLowerInvariant();
        }
    }
}
