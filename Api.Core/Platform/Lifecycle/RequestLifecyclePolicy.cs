using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Threading;

namespace Api.Core.Platform.Lifecycle
{
    public enum RequestWorkloadClass
    {
        InteractiveRead,
        Mutation,
        Bulk,
        Health
    }

    public readonly struct RequestLifecycleBudget
    {
        public RequestLifecycleBudget(
            RequestWorkloadClass workloadClass,
            TimeSpan timeout,
            bool exemptFromDrain)
        {
            WorkloadClass = workloadClass;
            Timeout = timeout;
            ExemptFromDrain = exemptFromDrain;
        }

        public RequestWorkloadClass WorkloadClass { get; }
        public TimeSpan Timeout { get; }
        public bool ExemptFromDrain { get; }
    }

    /// <summary>
    /// Deterministically maps an HTTP request to one closed workload class. Classification uses only
    /// method and path shape; query values, headers, identity and body content never influence
    /// lifecycle state or telemetry cardinality.
    /// </summary>
    public sealed class RequestLifecyclePolicy
    {
        private static readonly HashSet<string> SafeMethods = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase)
        {
            HttpMethods.Get,
            HttpMethods.Head,
            HttpMethods.Options
        };

        private readonly ApiPlatformOptions.LifecycleOptions _options;
        private readonly ApiPlatformOptions.HealthOptions _health;

        public RequestLifecyclePolicy(ApiPlatformOptions options)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            _options = options.Lifecycle ??
                throw new ArgumentException("Lifecycle options are required.", nameof(options));
            _health = options.Health ??
                throw new ArgumentException("Health options are required.", nameof(options));
        }

        public RequestLifecycleBudget Resolve(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var path = context.Request.Path;
            var method = context.Request.Method ?? string.Empty;

            if (IsHealthPath(path))
            {
                return Budget(
                    RequestWorkloadClass.Health,
                    _options.HealthTimeoutSeconds,
                    exemptFromDrain: true);
            }

            // OPTIONS is a transport preflight, not execution of the target bulk operation.
            if (HttpMethods.IsOptions(method))
            {
                return Budget(
                    RequestWorkloadClass.InteractiveRead,
                    _options.ReadTimeoutSeconds,
                    exemptFromDrain: false);
            }

            // Export/import endpoints can legitimately use GET/HEAD or mutation verbs. Classify the
            // bounded path segment before generic safe-method handling so expensive GET exports do
            // not inherit the shorter interactive-read budget.
            if (ContainsBulkSegment(path.Value))
            {
                return Budget(
                    RequestWorkloadClass.Bulk,
                    _options.BulkTimeoutSeconds,
                    exemptFromDrain: false);
            }

            if (SafeMethods.Contains(method))
            {
                return Budget(
                    RequestWorkloadClass.InteractiveRead,
                    _options.ReadTimeoutSeconds,
                    exemptFromDrain: false);
            }

            return Budget(
                RequestWorkloadClass.Mutation,
                _options.MutationTimeoutSeconds,
                exemptFromDrain: false);
        }

        private RequestLifecycleBudget Budget(
            RequestWorkloadClass workloadClass,
            int timeoutSeconds,
            bool exemptFromDrain) =>
            new RequestLifecycleBudget(
                workloadClass,
                TimeSpan.FromSeconds(timeoutSeconds),
                exemptFromDrain);

        private bool IsHealthPath(PathString path)
        {
            var value = path.Value ?? string.Empty;
            return string.Equals(
                       value,
                       _health.LivenessPath,
                       StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(
                       value,
                       _health.ReadinessPath,
                       StringComparison.OrdinalIgnoreCase);
        }

        private static bool ContainsBulkSegment(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            var index = 0;
            while (index < value.Length)
            {
                while (index < value.Length && value[index] == '/')
                {
                    index++;
                }

                if (index >= value.Length)
                {
                    break;
                }

                var start = index;
                while (index < value.Length && value[index] != '/')
                {
                    index++;
                }

                var segment = value.AsSpan(start, index - start);
                if (IsBulkSegment(segment))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsBulkSegment(ReadOnlySpan<char> segment) =>
            segment.Equals("import".AsSpan(), StringComparison.OrdinalIgnoreCase) ||
            segment.Equals("export".AsSpan(), StringComparison.OrdinalIgnoreCase) ||
            segment.Equals("bulk".AsSpan(), StringComparison.OrdinalIgnoreCase);
    }

    public sealed class RequestLifecycleLease : IDisposable
    {
        private readonly Action _release;
        private int _released;

        internal RequestLifecycleLease(
            long sequence,
            RequestLifecycleBudget budget,
            Action release)
        {
            Sequence = sequence;
            Budget = budget;
            _release = release ?? throw new ArgumentNullException(nameof(release));
        }

        public long Sequence { get; }
        public RequestLifecycleBudget Budget { get; }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                _release();
            }
        }
    }
}
