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
        private const string ContentSecurityPolicyHeader = "Content-Security-Policy";

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

            ApplyContentSecurityPolicy(context, headers);

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

        private void ApplyContentSecurityPolicy(HttpContext context, IHeaderDictionary headers)
        {
            var configuredPolicy = _options.ContentSecurityPolicy;
            if (string.IsNullOrWhiteSpace(configuredPolicy))
            {
                // A blank API baseline means this middleware does not own CSP for the response.
                // In particular, do not erase a policy supplied by an opt-in HTML surface.
                return;
            }

            if (!IsHtmlResponse(context))
            {
                // API/non-HTML responses are server-owned: re-apply the configured baseline so a
                // downstream component cannot silently weaken the shared API policy.
                headers[ContentSecurityPolicyHeader] = configuredPolicy;
                return;
            }

            // ApplyHeaders runs once before downstream code, when ContentType is commonly still
            // unset. That initial pass can place the API CSP on a response that later becomes HTML.
            // Remove only that exact middleware-owned value. If the HTML surface replaced it with
            // its own CSP, preserve the downstream policy instead of deleting it on response start.
            if (headers.TryGetValue(ContentSecurityPolicyHeader, out var currentPolicy) &&
                string.Equals(
                    currentPolicy.ToString(),
                    configuredPolicy,
                    StringComparison.Ordinal))
            {
                headers.Remove(ContentSecurityPolicyHeader);
            }
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
