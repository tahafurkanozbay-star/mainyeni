using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using System;
using System.Text.Json;
using System.Threading.Tasks;

namespace Api.Core.Platform.Middleware
{
    /// <summary>
    /// Converts unhandled request-pipeline exceptions into a stable RFC7807-compatible payload
    /// without exposing exception messages, stack traces, database details or upstream secrets.
    /// </summary>
    public sealed class ApiExceptionMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly ILogger<ApiExceptionMiddleware> _logger;

        public ApiExceptionMiddleware(
            RequestDelegate next,
            ILogger<ApiExceptionMiddleware> logger)
        {
            _next = next ?? throw new ArgumentNullException(nameof(next));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        public async Task Invoke(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            try
            {
                await _next(context);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                _logger.LogDebug(
                    "Request cancelled by client. TraceId: {TraceId}; CorrelationId: {CorrelationId}",
                    context.TraceIdentifier,
                    ResolveCorrelationId(context));

                // Once a client has disconnected, writing a body can cause a second exception.
                if (!context.Response.HasStarted && !context.RequestAborted.IsCancellationRequested)
                {
                    await WriteProblem(
                        context,
                        StatusCodes.Status408RequestTimeout,
                        "Request cancelled",
                        "The request was cancelled before completion.");
                }
            }
            catch (BadHttpRequestException exception)
            {
                _logger.LogWarning(
                    exception,
                    "Malformed HTTP request. TraceId: {TraceId}; CorrelationId: {CorrelationId}",
                    context.TraceIdentifier,
                    ResolveCorrelationId(context));

                if (!context.Response.HasStarted)
                {
                    var status = exception.StatusCode >= 400 && exception.StatusCode <= 499
                        ? exception.StatusCode
                        : StatusCodes.Status400BadRequest;
                    await WriteProblem(
                        context,
                        status,
                        "Invalid request",
                        "The request could not be processed because its HTTP metadata or payload is invalid.");
                }
            }
            catch (Exception exception)
            {
                _logger.LogError(
                    exception,
                    "Unhandled API exception. TraceId: {TraceId}; CorrelationId: {CorrelationId}",
                    context.TraceIdentifier,
                    ResolveCorrelationId(context));

                if (!context.Response.HasStarted)
                {
                    await WriteProblem(
                        context,
                        StatusCodes.Status500InternalServerError,
                        "Internal Server Error",
                        null);
                }
                else
                {
                    throw;
                }
            }
        }

        private static string ResolveCorrelationId(HttpContext context)
        {
            return context.Items.TryGetValue(ApiPlatformDefaults.TraceIdItemKey, out var value)
                ? value?.ToString()
                : null;
        }

        private static async Task WriteProblem(
            HttpContext context,
            int statusCode,
            string title,
            string detail)
        {
            context.Response.Clear();
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/problem+json";
            context.Response.Headers.CacheControl = "no-store";

            var payload = new ApiProblemResponse
            {
                Type = "about:blank",
                Title = title,
                Status = statusCode,
                Detail = detail,
                TraceId = context.TraceIdentifier,
                CorrelationId = ResolveCorrelationId(context)
            };

            await context.Response.WriteAsync(JsonSerializer.Serialize(payload, ApiProblemResponse.SerializerOptions));
        }

        internal sealed class ApiProblemResponse
        {
            internal static readonly JsonSerializerOptions SerializerOptions = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
            };

            public string Type { get; set; }

            public string Title { get; set; }

            public int Status { get; set; }

            public string Detail { get; set; }

            public string TraceId { get; set; }

            public string CorrelationId { get; set; }
        }
    }
}
