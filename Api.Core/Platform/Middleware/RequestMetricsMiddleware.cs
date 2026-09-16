using Api.Core.Platform.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;
using System;
using System.Diagnostics;
using System.Globalization;
using System.Threading.Tasks;

namespace Api.Core.Platform.Middleware
{
    /// <summary>
    /// Measures request latency and outcome at the shared platform boundary. Metrics intentionally
    /// use route templates instead of raw paths so account ids, object ids, search text and other
    /// user-provided path values do not become high-cardinality telemetry labels.
    /// </summary>
    public sealed class RequestMetricsMiddleware
    {
        private readonly RequestDelegate next;
        private readonly ApiRuntimeMetrics metrics;
        private readonly ApiPlatformOptions.DiagnosticsOptions options;

        public RequestMetricsMiddleware(
            RequestDelegate next,
            ApiRuntimeMetrics metrics,
            IOptions<ApiPlatformOptions> platformOptions)
        {
            this.next = next ?? throw new ArgumentNullException(nameof(next));
            this.metrics = metrics ?? throw new ArgumentNullException(nameof(metrics));
            if (platformOptions == null)
            {
                throw new ArgumentNullException(nameof(platformOptions));
            }

            options = platformOptions.Value.Diagnostics ?? new ApiPlatformOptions.DiagnosticsOptions();
        }

        public async Task InvokeAsync(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            if (!options.Enabled)
            {
                await next(context);
                return;
            }

            var route = ResolveRoute(context);
            var method = context.Request.Method;
            var started = Stopwatch.GetTimestamp();
            var requestLength = context.Request.ContentLength;
            var cancelled = false;
            Exception failure = null;

            metrics.RequestStarted(method, route);
            AttachActivityTags(context, route);

            if (options.ServerTimingHeader)
            {
                context.Response.OnStarting(() =>
                {
                    if (!context.Response.Headers.ContainsKey("Server-Timing"))
                    {
                        var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                        context.Response.Headers["Server-Timing"] =
                            "app;dur=" + elapsed.ToString("0.0", CultureInfo.InvariantCulture);
                    }

                    return Task.CompletedTask;
                });
            }

            try
            {
                await next(context);
            }
            catch (OperationCanceledException exception)
                when (context.RequestAborted.IsCancellationRequested)
            {
                cancelled = true;
                failure = exception;
                metrics.RequestCancelled(method, route);
                throw;
            }
            catch (Exception exception)
            {
                failure = exception;
                metrics.RequestFailed(
                    method,
                    route,
                    NormalizeFailureStatus(context.Response.StatusCode),
                    exception);
                throw;
            }
            finally
            {
                var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                var statusCode = cancelled
                    ? 499
                    : NormalizeResponseStatus(context.Response.StatusCode, failure);

                metrics.RequestCompleted(
                    method,
                    route,
                    statusCode,
                    elapsed,
                    requestLength,
                    context.Response.ContentLength);

                var activity = Activity.Current;
                if (activity != null)
                {
                    activity.SetTag("http.response.status_code", statusCode);
                    activity.SetTag("kentrehberi.request.duration_ms", elapsed);
                    if (failure != null)
                    {
                        activity.SetTag("error.type", failure.GetType().Name);
                    }
                }
            }
        }

        internal static string ResolveRoute(HttpContext context)
        {
            var endpoint = context.GetEndpoint();
            if (endpoint is RouteEndpoint routeEndpoint)
            {
                var rawText = routeEndpoint.RoutePattern.RawText;
                if (!string.IsNullOrWhiteSpace(rawText))
                {
                    return ApiRuntimeMetrics.NormalizeRoute(rawText);
                }
            }

            // Never fall back to Request.Path here. Raw request paths can contain sensitive or
            // unbounded user-controlled identifiers and would create unsafe metric cardinality.
            return "unmatched";
        }

        private static int NormalizeFailureStatus(int currentStatus)
        {
            if (currentStatus >= 400 && currentStatus <= 599)
            {
                return currentStatus;
            }

            return StatusCodes.Status500InternalServerError;
        }

        private static int NormalizeResponseStatus(int currentStatus, Exception failure)
        {
            if (failure != null && currentStatus < 400)
            {
                return StatusCodes.Status500InternalServerError;
            }

            return Math.Clamp(currentStatus, 100, 599);
        }

        private static void AttachActivityTags(HttpContext context, string route)
        {
            var activity = Activity.Current;
            if (activity == null)
            {
                return;
            }

            activity.SetTag("http.request.method", ApiRuntimeMetrics.NormalizeMethod(context.Request.Method));
            activity.SetTag("http.route", ApiRuntimeMetrics.NormalizeRoute(route));
        }
    }
}
