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
        public RequestLifecycleBudget(RequestWorkloadClass workloadClass, TimeSpan timeout, bool exemptFromDrain)
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
    /// Deterministic request lifecycle classification. The policy intentionally uses only method,
    /// endpoint metadata and normalized path shape; it never retains bodies, query values, claims,
    /// credentials or HttpContext instances.
    /// </summary>
    public sealed class RequestLifecyclePolicy
    {
        private static readonly HashSet<string> SafeMethods = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            HttpMethods.Get, HttpMethods.Head, HttpMethods.Options
        };

        private readonly ApiPlatformOptions.LifecycleOptions _options;
        private readonly ApiPlatformOptions.HealthOptions _health;

        public RequestLifecyclePolicy(ApiPlatformOptions options)
        {
            if (options == null) throw new ArgumentNullException(nameof(options));
            _options = options.Lifecycle ?? throw new ArgumentException("Lifecycle options are required.", nameof(options));
            _health = options.Health ?? throw new ArgumentException("Health options are required.", nameof(options));
        }

        public RequestLifecycleBudget Resolve(HttpContext context)
        {
            if (context == null) throw new ArgumentNullException(nameof(context));

            if (IsHealthPath(context.Request.Path))
            {
                return new RequestLifecycleBudget(
                    RequestWorkloadClass.Health,
                    TimeSpan.FromSeconds(_options.HealthTimeoutSeconds),
                    exemptFromDrain: true);
            }

            var method = context.Request.Method ?? string.Empty;
            if (SafeMethods.Contains(method))
            {
                return new RequestLifecycleBudget(
                    RequestWorkloadClass.InteractiveRead,
                    TimeSpan.FromSeconds(_options.ReadTimeoutSeconds),
                    exemptFromDrain: false);
            }

            if (IsBulkPath(context.Request.Path))
            {
                return new RequestLifecycleBudget(
                    RequestWorkloadClass.Bulk,
                    TimeSpan.FromSeconds(_options.BulkTimeoutSeconds),
                    exemptFromDrain: false);
            }

            return new RequestLifecycleBudget(
                RequestWorkloadClass.Mutation,
                TimeSpan.FromSeconds(_options.MutationTimeoutSeconds),
                exemptFromDrain: false);
        }

        private bool IsHealthPath(PathString path)
        {
            return path.Equals(_health.LivenessPath, StringComparison.OrdinalIgnoreCase) ||
                   path.Equals(_health.ReadinessPath, StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsBulkPath(PathString path)
        {
            var value = path.Value ?? string.Empty;
            return value.IndexOf("/export", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   value.IndexOf("/import", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   value.IndexOf("/bulk", StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    public sealed class RequestLifecycleLease : IDisposable
    {
        private readonly Action _release;
        private int _released;

        internal RequestLifecycleLease(long sequence, RequestLifecycleBudget budget, Action release)
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
