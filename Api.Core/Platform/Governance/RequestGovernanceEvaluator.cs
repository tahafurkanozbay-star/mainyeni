using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using System;

namespace Api.Core.Platform.Governance
{
    /// <summary>
    /// Pure preflight evaluator for request-target, header and content boundaries. It performs no
    /// I/O and does not read the request body, so it can run before model binding with predictable
    /// memory and CPU cost.
    /// </summary>
    public sealed class RequestGovernanceEvaluator
    {
        private readonly ApiPlatformOptions options;
        private readonly ApiPlatformOptions.GovernanceOptions governance;

        public RequestGovernanceEvaluator(ApiPlatformOptions options)
        {
            this.options = options ?? throw new ArgumentNullException(nameof(options));
            governance = options.Governance ?? new ApiPlatformOptions.GovernanceOptions();
        }

        public RequestGovernanceDecision Evaluate(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            if (!governance.Enabled)
            {
                return RequestGovernanceDecision.Allow();
            }

            var request = context.Request;
            var methodDecision = EvaluateMethod(request.Method);
            if (!methodDecision.Allowed)
            {
                return methodDecision;
            }

            var rawTarget = ResolveRawTarget(context);
            var target = RequestTargetInspector.Inspect(rawTarget);
            var targetDecision = EvaluateTarget(target);
            if (!targetDecision.Allowed)
            {
                return targetDecision;
            }

            var headers = RequestHeaderInspector.Inspect(request.Headers);
            var headerDecision = EvaluateHeaders(headers, request.Headers);
            if (!headerDecision.Allowed)
            {
                return headerDecision;
            }

            return EvaluateContent(request);
        }

        public bool ShouldBypassConcurrency(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var concurrency = governance.Concurrency;
            if (concurrency == null || !concurrency.Enabled)
            {
                return true;
            }

            if (concurrency.ExemptOptionsRequests &&
                HttpMethods.IsOptions(context.Request.Method))
            {
                return true;
            }

            if (concurrency.ExemptHealthChecks &&
                Api.Core.Platform.RateLimiting.ClientRateLimitPartitioner.IsHealthPath(
                    context.Request.Path,
                    options.Health))
            {
                return true;
            }

            return false;
        }

        internal RequestGovernanceDecision EvaluateMethod(string method)
        {
            if (!governance.RejectTraceAndConnect)
            {
                return RequestGovernanceDecision.Allow();
            }

            if (string.Equals(method, "TRACE", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(method, "CONNECT", StringComparison.OrdinalIgnoreCase))
            {
                return RequestGovernanceDecision.Reject(
                    StatusCodes.Status405MethodNotAllowed,
                    "method-not-allowed",
                    "HTTP method not allowed",
                    "This HTTP method is not enabled by the API runtime.");
            }

            return RequestGovernanceDecision.Allow();
        }

        internal RequestGovernanceDecision EvaluateTarget(RequestTargetSnapshot target)
        {
            if (target.RawTargetLength > governance.MaxRawTargetChars)
            {
                return RejectUri("raw-target-too-long", "The request target exceeds the server limit.");
            }

            if (target.PathLength > governance.MaxPathChars)
            {
                return RejectUri("path-too-long", "The request path exceeds the server limit.");
            }

            if (target.QueryLength > governance.MaxQueryStringChars)
            {
                return RejectUri("query-too-long", "The query string exceeds the server limit.");
            }

            if (target.QueryParameterCount > governance.MaxQueryParameters)
            {
                return RejectBadRequest(
                    "too-many-query-parameters",
                    "The request contains too many query parameters.");
            }

            if (target.ContainsControlCharacters)
            {
                return RejectBadRequest(
                    "request-target-control-character",
                    "The request target contains invalid control characters.");
            }

            if (governance.RejectBackslashInPath && target.ContainsBackslash)
            {
                return RejectBadRequest(
                    "backslash-in-path",
                    "Backslashes are not accepted in API paths.");
            }

            if (governance.RejectPathTraversal &&
                (target.ContainsPlainTraversal || target.ContainsEncodedTraversal))
            {
                return RejectBadRequest(
                    "path-traversal",
                    "Path traversal sequences are not accepted.");
            }

            if (governance.RejectEncodedPathSeparators && target.ContainsEncodedSeparator)
            {
                return RejectBadRequest(
                    "encoded-path-separator",
                    "Encoded path separators are not accepted.");
            }

            return RequestGovernanceDecision.Allow();
        }

        internal RequestGovernanceDecision EvaluateHeaders(
            RequestHeaderSnapshot headers,
            IHeaderDictionary values)
        {
            if (headers.ContentLengthValueCount > 0 &&
                headers.TransferEncodingValueCount > 0)
            {
                return RejectBadRequest(
                    "ambiguous-body-framing",
                    "Content-Length and Transfer-Encoding cannot be combined.");
            }

            if (headers.ContentLengthValueCount > 1)
            {
                return RejectBadRequest(
                    "multiple-content-length",
                    "Multiple Content-Length header values are not accepted.");
            }

            if (headers.AuthorizationValueCount > 1)
            {
                return RejectBadRequest(
                    "multiple-authorization-values",
                    "Multiple Authorization header values are not accepted.");
            }

            if (headers.HostValueCount > 1)
            {
                return RejectBadRequest(
                    "multiple-host-values",
                    "Multiple Host header values are not accepted.");
            }

            if (headers.HeaderCount > governance.MaxHeaderCount)
            {
                return RejectHeaders("too-many-headers", "The request contains too many headers.");
            }

            if (headers.HeaderValueCount > governance.MaxHeaderValues)
            {
                return RejectHeaders(
                    "too-many-header-values",
                    "The request contains too many header values.");
            }

            if (headers.EstimatedUtf8Bytes > governance.MaxHeaderBytes)
            {
                return RejectHeaders(
                    "headers-too-large",
                    "The request headers exceed the server byte budget.");
            }

            if (headers.AuthorizationBytes > governance.MaxAuthorizationHeaderBytes)
            {
                return RejectHeaders(
                    "authorization-header-too-large",
                    "The authorization header exceeds the server limit.");
            }

            if (headers.CookieBytes > governance.MaxCookieHeaderBytes)
            {
                return RejectHeaders(
                    "cookie-header-too-large",
                    "The cookie header exceeds the server limit.");
            }

            if (headers.ContentTypeBytes > governance.MaxContentTypeHeaderBytes)
            {
                return RejectHeaders(
                    "content-type-header-too-large",
                    "The content type header exceeds the server limit.");
            }

            if (headers.ForwardedForBytes > governance.MaxForwardedForHeaderBytes)
            {
                return RejectHeaders(
                    "forwarded-for-header-too-large",
                    "The forwarded-address header exceeds the server limit.");
            }

            if (governance.RejectHeaderNewlines &&
                RequestHeaderInspector.ContainsNewline(values))
            {
                return RejectHeaders(
                    "header-newline",
                    "Request header values must not contain newline characters.");
            }

            return RequestGovernanceDecision.Allow();
        }

        internal RequestGovernanceDecision EvaluateContent(HttpRequest request)
        {
            if (!governance.RequireKnownContentTypeForBodyRequests ||
                !RequestContentPolicy.MethodCanCarryBody(request.Method) ||
                !RequestContentPolicy.HasBody(request))
            {
                return RequestGovernanceDecision.Allow();
            }

            var contentType = request.ContentType;
            if (string.IsNullOrWhiteSpace(contentType))
            {
                return RequestGovernanceDecision.Reject(
                    StatusCodes.Status415UnsupportedMediaType,
                    "content-type-required",
                    "Content type required",
                    "Requests with a body must declare a supported Content-Type.");
            }

            if (!RequestContentPolicy.IsAllowed(
                    contentType,
                    governance.AllowedBodyContentTypes))
            {
                return RequestGovernanceDecision.Reject(
                    StatusCodes.Status415UnsupportedMediaType,
                    "unsupported-content-type",
                    "Unsupported media type",
                    "The request Content-Type is not enabled by the API runtime.");
            }

            return RequestGovernanceDecision.Allow();
        }

        private static string ResolveRawTarget(HttpContext context)
        {
            var rawTarget = context.Features.Get<IHttpRequestFeature>()?.RawTarget;
            if (!string.IsNullOrEmpty(rawTarget))
            {
                return rawTarget;
            }

            return (context.Request.PathBase.Value ?? string.Empty) +
                   (context.Request.Path.Value ?? string.Empty) +
                   (context.Request.QueryString.Value ?? string.Empty);
        }

        private static RequestGovernanceDecision RejectUri(
            string code,
            string detail)
        {
            return RequestGovernanceDecision.Reject(
                StatusCodes.Status414UriTooLong,
                code,
                "Request target too large",
                detail);
        }

        private static RequestGovernanceDecision RejectHeaders(
            string code,
            string detail)
        {
            return RequestGovernanceDecision.Reject(
                StatusCodes.Status431RequestHeaderFieldsTooLarge,
                code,
                "Request headers rejected",
                detail);
        }

        private static RequestGovernanceDecision RejectBadRequest(
            string code,
            string detail)
        {
            return RequestGovernanceDecision.Reject(
                StatusCodes.Status400BadRequest,
                code,
                "Invalid request metadata",
                detail);
        }
    }
}
