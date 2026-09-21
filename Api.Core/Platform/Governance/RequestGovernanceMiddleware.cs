using Api.Core.Platform.Diagnostics;
using Api.Core.Platform.Middleware;
using Api.Core.Platform.RateLimiting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Enforces request metadata and concurrency budgets before controllers allocate expensive
    /// resources. The middleware never logs client-supplied values: only a fixed policy code,
    /// normalized HTTP method and endpoint route are used for diagnostics.
    /// </summary>
    public sealed class RequestGovernanceMiddleware
    {
        private static readonly JsonSerializerOptions SerializerOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private readonly RequestDelegate next;
        private readonly RequestGovernanceEvaluator evaluator;
        private readonly RequestConcurrencyGovernor governor;
        private readonly ApiPlatformOptions options;
        private readonly ILogger<RequestGovernanceMiddleware> logger;

        public RequestGovernanceMiddleware(
            RequestDelegate next,
            IOptions<ApiPlatformOptions> options,
            RequestConcurrencyGovernor governor,
            ILogger<RequestGovernanceMiddleware> logger)
        {
            this.next = next ?? throw new ArgumentNullException(nameof(next));
            this.options = options?.Value ?? throw new ArgumentNullException(nameof(options));
            this.governor = governor ?? throw new ArgumentNullException(nameof(governor));
            this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
            evaluator = new RequestGovernanceEvaluator(this.options);
        }

        public async Task Invoke(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var decision = evaluator.Evaluate(context);
            if (!decision.Allowed)
            {
                RecordRejection(context, decision.Code, decision.StatusCode);
                await WriteProblem(context, decision, context.RequestAborted);
                return;
            }

            if (evaluator.ShouldBypassConcurrency(context))
            {
                await next(context);
                return;
            }

            var partitionKey = ClientRateLimitPartitioner.ResolvePartitionKey(context, options);
            using var lease = governor.TryAcquire(partitionKey);

            if (!lease.IsAcquired)
            {
                var retryAfter = Math.Clamp(
                    options.Governance.Concurrency.RetryAfterSeconds,
                    1,
                    3600);
                var code = lease.Rejection == RequestConcurrencyRejection.ClientLimit
                    ? "client-concurrency-limit"
                    : "global-concurrency-limit";

                var overload = RequestGovernanceDecision.Reject(
                    StatusCodes.Status503ServiceUnavailable,
                    code,
                    "Service temporarily busy",
                    "The API is at its bounded concurrency capacity. Retry after the indicated delay.",
                    retryAfter);

                RecordRejection(context, overload.Code, overload.StatusCode);
                await WriteProblem(context, overload, context.RequestAborted);
                return;
            }

            await next(context);
        }

        private void RecordRejection(
            HttpContext context,
            string code,
            int statusCode)
        {
            logger.LogWarning(
                "API request governance rejected {Method} {Route} with policy {PolicyCode} and status {StatusCode}.",
                ApiRuntimeMetrics.NormalizeMethod(context.Request.Method),
                RequestMetricsMiddleware.ResolveRoute(context),
                code,
                statusCode);

            var metrics = context.RequestServices.GetService<ApiRuntimeMetrics>();
            metrics?.GovernanceRejected(
                context.Request.Method,
                RequestMetricsMiddleware.ResolveRoute(context),
                statusCode,
                code);
        }

        private static async Task WriteProblem(
            HttpContext context,
            RequestGovernanceDecision decision,
            CancellationToken cancellationToken)
        {
            if (context.Response.HasStarted)
            {
                return;
            }

            context.Response.Clear();
            context.Response.StatusCode = decision.StatusCode;
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers.CacheControl = "no-store";

            if (decision.RetryAfterSeconds.HasValue)
            {
                context.Response.Headers["Retry-After"] =
                    decision.RetryAfterSeconds.Value.ToString(CultureInfo.InvariantCulture);
            }

            var correlationId = context.Items.TryGetValue(
                ApiPlatformDefaults.TraceIdItemKey,
                out var value)
                    ? value?.ToString()
                    : null;

            var payload = new GovernanceProblemResponse
            {
                Type = "about:blank",
                Title = decision.Title,
                Status = decision.StatusCode,
                Detail = decision.Detail,
                Code = decision.Code,
                TraceId = context.TraceIdentifier,
                CorrelationId = correlationId,
                RetryAfterSeconds = decision.RetryAfterSeconds
            };

            await context.Response.WriteAsync(
                JsonSerializer.Serialize(payload, SerializerOptions),
                cancellationToken);
        }

        private sealed class GovernanceProblemResponse
        {
            public string Type { get; set; }

            public string Title { get; set; }

            public int Status { get; set; }

            public string Detail { get; set; }

            public string Code { get; set; }

            public string TraceId { get; set; }

            public string CorrelationId { get; set; }

            public int? RetryAfterSeconds { get; set; }
        }
    }
}
