using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;

namespace Api.Core.Platform.Lifecycle
{
    /// <summary>
    /// Canonical validator for request-lifecycle budgets and their cross-section timeout contract.
    /// Keeping these rules outside middleware/DI wiring prevents runtime authorities from drifting
    /// apart as configuration evolves.
    /// </summary>
    public static class LifecycleConfigurationValidator
    {
        public static ValidateOptionsResult Validate(ApiPlatformOptions options)
        {
            if (options == null)
            {
                return ValidateOptionsResult.Fail("Platform configuration is required.");
            }

            var failures = new List<string>();
            var lifecycle = options.Lifecycle;
            if (lifecycle == null)
            {
                failures.Add("Platform:Lifecycle configuration is required.");
                return ValidateOptionsResult.Fail(failures);
            }

            ValidateRange(
                lifecycle.ReadTimeoutSeconds,
                1,
                300,
                "ReadTimeoutSeconds",
                failures);
            ValidateRange(
                lifecycle.MutationTimeoutSeconds,
                1,
                300,
                "MutationTimeoutSeconds",
                failures);
            ValidateRange(
                lifecycle.BulkTimeoutSeconds,
                1,
                900,
                "BulkTimeoutSeconds",
                failures);
            ValidateRange(
                lifecycle.HealthTimeoutSeconds,
                1,
                30,
                "HealthTimeoutSeconds",
                failures);
            ValidateRange(
                lifecycle.ShutdownDrainSeconds,
                1,
                120,
                "ShutdownDrainSeconds",
                failures);

            if (lifecycle.HealthTimeoutSeconds > lifecycle.ReadTimeoutSeconds)
            {
                failures.Add(
                    "Platform:Lifecycle:HealthTimeoutSeconds cannot exceed ReadTimeoutSeconds.");
            }

            ValidateDependencyProbeBudget(options, failures);

            return failures.Count == 0
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(failures);
        }

        public static void ThrowIfInvalid(ApiPlatformOptions options)
        {
            var result = Validate(options);
            if (!result.Succeeded)
            {
                throw new OptionsValidationException(
                    Options.DefaultName,
                    typeof(ApiPlatformOptions),
                    result.Failures);
            }
        }

        private static void ValidateDependencyProbeBudget(
            ApiPlatformOptions options,
            ICollection<string> failures)
        {
            var health = options.Health;
            if (health == null || !health.Enabled)
            {
                return;
            }

            var lifecycle = options.Lifecycle;
            var requests = options.Requests;
            if (lifecycle == null || requests == null)
            {
                return;
            }

            var outerTimeoutSeconds = lifecycle.Enabled
                ? lifecycle.HealthTimeoutSeconds
                : requests.TimeoutSeconds;

            if (health.DatabaseTimeoutSeconds >= outerTimeoutSeconds)
            {
                var authority = lifecycle.Enabled
                    ? "Platform:Lifecycle:HealthTimeoutSeconds"
                    : "Platform:Requests:TimeoutSeconds";
                failures.Add(
                    "Platform:Health:DatabaseTimeoutSeconds must be lower than " +
                    authority +
                    " so dependency timeout handling can complete before the request deadline.");
            }
        }

        private static void ValidateRange(
            int value,
            int minimum,
            int maximum,
            string settingName,
            ICollection<string> failures)
        {
            if (value < minimum || value > maximum)
            {
                failures.Add(
                    $"Platform:Lifecycle:{settingName} must be between {minimum} and {maximum}.");
            }
        }
    }
}
