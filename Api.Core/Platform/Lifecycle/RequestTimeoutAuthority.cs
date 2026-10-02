using System;

namespace Api.Core.Platform.Lifecycle
{
    /// <summary>
    /// Selects exactly one request-timeout authority for the process. Lifecycle governance owns
    /// per-workload timeout budgets when enabled; the ASP.NET default timeout remains only as a
    /// compatibility fallback for deployments that explicitly disable lifecycle governance.
    /// </summary>
    public static class RequestTimeoutAuthority
    {
        public static bool UsesLifecycleTimeouts(ApiPlatformOptions options)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            if (options.Lifecycle == null)
            {
                throw new ArgumentException(
                    "Lifecycle options are required to select the request timeout authority.",
                    nameof(options));
            }

            return options.Lifecycle.Enabled;
        }

        public static bool UsesFrameworkDefaultTimeout(ApiPlatformOptions options) =>
            !UsesLifecycleTimeouts(options);
    }
}
