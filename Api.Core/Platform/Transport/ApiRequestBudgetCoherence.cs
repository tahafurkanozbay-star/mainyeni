using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Api.Core.Platform.Transport
{
    /// <summary>
    /// Validates request-budget relationships that cross the HTTP transport and application
    /// governance layers. Independent range validation is not enough: a narrower Kestrel ceiling
    /// can reject a request before repository-owned middleware has a chance to apply the intended
    /// problem-response contract.
    /// </summary>
    public static class ApiRequestBudgetCoherence
    {
        public static IReadOnlyList<string> Validate(ApiPlatformOptions options)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            var failures = new List<string>();
            var transport = options.Transport;
            var requests = options.Requests;

            if (transport == null)
            {
                failures.Add("Platform:Transport configuration is required for request-budget coherence.");
                return failures;
            }

            if (requests == null)
            {
                failures.Add("Platform:Requests configuration is required for request-budget coherence.");
            }
            else if (transport.MaxRequestBodyBytes < requests.MaxRequestBodyBytes)
            {
                failures.Add(
                    "Platform:Transport:MaxRequestBodyBytes must be greater than or equal to " +
                    "Platform:Requests:MaxRequestBodyBytes so Kestrel does not reject a body " +
                    "before the application request guard can enforce the configured 413 contract.");
            }

            var governance = options.Governance;
            if (governance == null || !governance.Enabled)
            {
                return failures;
            }

            if (transport.MaxRequestHeadersTotalSizeBytes < governance.MaxHeaderBytes)
            {
                failures.Add(
                    "Platform:Transport:MaxRequestHeadersTotalSizeBytes must be greater than or equal to " +
                    "Platform:Governance:MaxHeaderBytes so request governance remains the effective " +
                    "header-byte ceiling.");
            }

            if (transport.MaxRequestHeaderCount < governance.MaxHeaderCount)
            {
                failures.Add(
                    "Platform:Transport:MaxRequestHeaderCount must be greater than or equal to " +
                    "Platform:Governance:MaxHeaderCount so request governance remains the effective " +
                    "header-count ceiling.");
            }

            // Kestrel's MaxRequestLineSize is byte-based while Governance.MaxRawTargetChars is a
            // character budget. Treating those values as interchangeable would create a false
            // invariant for non-ASCII/escaped targets. A request-target byte ceiling should be
            // introduced explicitly before those two settings are coupled.

            return failures;
        }

        public static void EnsureValid(ApiPlatformOptions options)
        {
            var failures = Validate(options);
            if (failures.Count == 0)
            {
                return;
            }

            throw new OptionsValidationException(
                Options.DefaultName,
                typeof(ApiPlatformOptions),
                failures.ToArray());
        }
    }
}
