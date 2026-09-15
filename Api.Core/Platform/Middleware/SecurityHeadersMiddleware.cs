using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
using System;
using System.Globalization;
using System.Threading.Tasks;

namespace Api.Core.Platform.Middleware
{
    /// <summary>
    /// Applies the API security-header baseline in one place so public and administrative APIs
    /// cannot drift. Headers are established before downstream middleware and re-applied on
    /// response start so late downstream mutations cannot weaken the server-owned baseline.
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

            ApplyHeaders(context);
            context.Response.OnStarting(() =>
            {
                ApplyHeaders(context);
                return Task.CompletedTask;
            });

            await _next(context);

            // DefaultHttpContext and other hostless pipelines do not necessarily execute
            // OnStarting callbacks. Re-apply while headers remain mutable so tests and custom
            // hosts observe the same contract as Kestrel without weakening production behavior.
            if (!context.Response.HasStarted)
            {
                ApplyHeaders(context);
            }
        }

        private void ApplyHeaders(HttpContext context)
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

            // The default CSP is intentionally API-oriented. Do not apply it to an explicitly HTML
            // response such as opt-in Swagger UI because default-src 'none' would break the page.
            // Product HTML surfaces should own their own CSP rather than weakening the API baseline.
            if (!string.IsNullOrWhiteSpace(_options.ContentSecurityPolicy) && !IsHtmlResponse(context))
            {
                headers["Content-Security-Policy"] = _options.ContentSecurityPolicy;
            }
            else
            {
                headers.Remove("Content-Security-Policy");
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

            headers.Remove("X-Powered-By");
            headers.Remove("X-AspNet-Version");
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
