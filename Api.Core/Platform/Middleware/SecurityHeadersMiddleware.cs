using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using System;
using System.Globalization;
using System.Threading.Tasks;

namespace Api.Core.Platform.Middleware
{
    /// <summary>
    /// Applies the API security-header baseline in one place so public and administrative APIs
    /// cannot drift. Stable headers are written before downstream execution; the CSP is finalized
    /// at response start because HTML surfaces such as opt-in Swagger own a separate policy.
    /// </summary>
    public sealed class SecurityHeadersMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly ApiPlatformOptions.SecurityHeaderOptions _options;

        public SecurityHeadersMiddleware(
            RequestDelegate next,
            IOptions<ApiPlatformOptions> options)
        {
            _next = next ?? throw new ArgumentNullException(nameof(next));
            _options = options?.Value?.SecurityHeaders ?? throw new ArgumentNullException(nameof(options));
        }

        public async Task Invoke(HttpContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            if (!_options.Enabled)
            {
                await _next(context);
                return;
            }

            ApplyStableHeaders(context);
            ApplyContentSecurityPolicy(context);

            // Content-Type can be assigned by downstream middleware/controllers. Re-evaluate CSP
            // immediately before the server starts the response so HTML never inherits the strict
            // API-only policy. The eager call above keeps the invariant deterministic for short
            // circuits and test hosts that do not execute OnStarting callbacks like Kestrel does.
            context.Response.OnStarting(() =>
            {
                ApplyContentSecurityPolicy(context);
                return Task.CompletedTask;
            });

            await _next(context);

            if (!context.Response.HasStarted)
            {
                ApplyContentSecurityPolicy(context);
            }
        }

        private void ApplyStableHeaders(HttpContext context)
        {
            var headers = context.Response.Headers;
            headers["X-Content-Type-Options"] = "nosniff";
            headers["X-Frame-Options"] = _options.FrameOptions;
            headers["Referrer-Policy"] = _options.ReferrerPolicy;
            headers["Permissions-Policy"] = _options.PermissionsPolicy;
            headers["Cross-Origin-Resource-Policy"] = _options.CrossOriginResourcePolicy;
            headers["Cross-Origin-Opener-Policy"] = _options.CrossOriginOpenerPolicy;

            if (!string.IsNullOrWhiteSpace(_options.CrossOriginEmbedderPolicy))
            {
                headers["Cross-Origin-Embedder-Policy"] = _options.CrossOriginEmbedderPolicy;
            }
            else
            {
                headers.Remove("Cross-Origin-Embedder-Policy");
            }

            if (_options.EnableHsts && context.Request.IsHttps)
            {
                var hsts = "max-age=" + _options.HstsMaxAgeSeconds.ToString(CultureInfo.InvariantCulture);
                if (_options.HstsIncludeSubDomains)
                {
                    hsts += "; includeSubDomains";
                }
                headers["Strict-Transport-Security"] = hsts;
            }
            else
            {
                headers.Remove("Strict-Transport-Security");
            }

            // APIs should not leak implementation/platform version information through this layer.
            headers.Remove("X-Powered-By");
            headers.Remove("X-AspNet-Version");
        }

        private void ApplyContentSecurityPolicy(HttpContext context)
        {
            var headers = context.Response.Headers;
            if (string.IsNullOrWhiteSpace(_options.ContentSecurityPolicy) || IsHtmlResponse(context))
            {
                headers.Remove("Content-Security-Policy");
                return;
            }

            headers["Content-Security-Policy"] = _options.ContentSecurityPolicy;
        }

        private static bool IsHtmlResponse(HttpContext context)
        {
            var contentType = context.Response.ContentType;
            if (string.IsNullOrWhiteSpace(contentType))
            {
                return false;
            }

            return contentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ||
                   contentType.StartsWith("application/xhtml+xml", StringComparison.OrdinalIgnoreCase);
        }
    }
}
