using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Lifecycle
{
    public sealed class RequestLifecycleMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly RequestLifecyclePolicy _policy;
        private readonly RequestLifecycleCoordinator _coordinator;
        private readonly ILogger<RequestLifecycleMiddleware> _logger;
        private readonly RequestLifecycleMetrics _metrics;

        public RequestLifecycleMiddleware(RequestDelegate next, RequestLifecyclePolicy policy, RequestLifecycleCoordinator coordinator, ILogger<RequestLifecycleMiddleware> logger, RequestLifecycleMetrics metrics = null)
        {
            _next = next ?? throw new ArgumentNullException(nameof(next));
            _policy = policy ?? throw new ArgumentNullException(nameof(policy));
            _coordinator = coordinator ?? throw new ArgumentNullException(nameof(coordinator));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _metrics = metrics;
        }

        public async Task InvokeAsync(HttpContext context)
        {
            if (context == null) throw new ArgumentNullException(nameof(context));
            var budget = _policy.Resolve(context);
            if (!_coordinator.TryAcquire(budget, out var lease))
            {
                await WriteDrainingResponse(context);
                return;
            }

            using (lease)
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted))
            {
                timeout.CancelAfter(budget.Timeout);
                var originalAbort = context.RequestAborted;
                context.RequestAborted = timeout.Token;
                context.Items[ApiPlatformDefaults.RequestWorkloadClassItemKey] = budget.WorkloadClass.ToString();
                context.Items[ApiPlatformDefaults.RequestTimeoutMillisecondsItemKey] = (long)budget.Timeout.TotalMilliseconds;
                try
                {
                    await _next(context);
                }
                catch (OperationCanceledException) when (timeout.IsCancellationRequested && !originalAbort.IsCancellationRequested)
                {
                    _metrics?.RequestTimedOut(budget);
                    if (!context.Response.HasStarted)
                    {
                        context.Response.Clear();
                        await WriteTimeoutResponse(context, budget);
                        return;
                    }
                    _logger.LogWarning("Request lifecycle timeout occurred after response start. Workload={WorkloadClass} TraceId={TraceId}", budget.WorkloadClass, context.TraceIdentifier);
                    throw;
                }
                catch (OperationCanceledException) when (originalAbort.IsCancellationRequested)
                {
                    _metrics?.RequestClientCancelled(budget);
                    throw;
                }
                finally
                {
                    context.RequestAborted = originalAbort;
                }
            }
        }

        private static Task WriteDrainingResponse(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers["Cache-Control"] = "no-store";
            context.Response.Headers["Retry-After"] = "1";
            return context.Response.WriteAsync(JsonSerializer.Serialize(new
            {
                type = "about:blank",
                title = "Service is draining",
                status = StatusCodes.Status503ServiceUnavailable,
                traceId = context.TraceIdentifier
            }));
        }

        private static Task WriteTimeoutResponse(HttpContext context, RequestLifecycleBudget budget)
        {
            context.Response.StatusCode = StatusCodes.Status504GatewayTimeout;
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers["Cache-Control"] = "no-store";
            return context.Response.WriteAsync(JsonSerializer.Serialize(new
            {
                type = "about:blank",
                title = "Request timed out",
                status = StatusCodes.Status504GatewayTimeout,
                workload = budget.WorkloadClass.ToString(),
                traceId = context.TraceIdentifier
            }));
        }
    }
}
