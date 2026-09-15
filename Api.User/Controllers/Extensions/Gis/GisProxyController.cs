using System;
using System.IO;
using System.Net;
using System.Text.Json;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis._Base;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using RestSharp;

namespace CityWorks.UserApi.Gis
{
    /// <summary>
    /// Server-owned proxy for configured ArcGIS REST services.
    /// The browser receives an encrypted service identity (Eg) instead of the
    /// configured upstream URL and all target resolution is repeated here.
    /// </summary>
    public class GisProxyController : _BaseUserApiController
    {
        private const string VirtualGisDomain = ".gissrv.org";
        private const int TokenExpirationMinutes = 30;

        private readonly GisConfigServiceOperations configServiceOperations;
        private readonly GisLayerOperations gisLayerOperations;
        private readonly GisBasemapLayerOperations gisBasemapLayerOperations;
        private readonly IMemoryCache memoryCache;

        public GisProxyController(
            IConfiguration configuration,
            IMemoryCache memoryCache,
            BusinessContext context)
        {
            this.configuration = configuration;
            this.dbContext = context;
            this.configServiceOperations = new GisConfigServiceOperations(context);
            this.gisLayerOperations = new GisLayerOperations(context);
            this.gisBasemapLayerOperations = new GisBasemapLayerOperations(context);
            this.memoryCache = memoryCache;
        }

        /// <summary>
        /// Proxies GET/POST requests only to GIS services already present in
        /// server-side configuration. Arbitrary browser supplied hosts are not
        /// accepted as proxy targets.
        /// </summary>
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/Proxy")]
        [HttpGet]
        [HttpPost]
        public async Task<IActionResult> Process()
        {
            if (!HttpMethods.IsGet(HttpContext.Request.Method) &&
                !HttpMethods.IsPost(HttpContext.Request.Method))
            {
                return StatusCode(StatusCodes.Status405MethodNotAllowed);
            }

            try
            {
                if (!TryReadProxyTarget(out var target))
                {
                    return BadRequest("Invalid GIS proxy target.");
                }

                var resolved = ResolveConfiguredService(target.BaseUrl);
                if (resolved.Service == null)
                {
                    return NotFound();
                }

                if (!TryBuildRequestUrl(target, resolved, out var requestUrl))
                {
                    return BadRequest("Invalid GIS proxy request.");
                }

                if (resolved.Service.RequiresSC)
                {
                    var token = await GetServiceToken(resolved.Service);
                    if (String.IsNullOrWhiteSpace(token))
                    {
                        return StatusCode(
                            StatusCodes.Status502BadGateway,
                            "GIS service token could not be acquired.");
                    }
                    requestUrl = AppendQueryParameter(requestUrl, "token", token);
                }

                return await ForwardRequest(requestUrl);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return StatusCode(
                    StatusCodes.Status502BadGateway,
                    "GIS proxy request failed.");
            }
        }

        private bool TryReadProxyTarget(out ProxyTarget target)
        {
            target = null;
            var raw = HttpContext.Request.QueryString.Value;
            if (String.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            raw = raw.TrimStart('?').Trim();
            if (String.IsNullOrWhiteSpace(raw))
            {
                return false;
            }

            // ArcGIS JS proxy convention sends the upstream URL immediately
            // after the proxy "?". Preserve the first '?' inside that URL as
            // the beginning of the upstream query string.
            var decoded = Uri.UnescapeDataString(raw);
            var queryIndex = decoded.IndexOf('?');
            var baseUrl = queryIndex >= 0 ? decoded.Substring(0, queryIndex) : decoded;
            var upstreamQuery = queryIndex >= 0 && queryIndex + 1 < decoded.Length
                ? decoded.Substring(queryIndex + 1)
                : String.Empty;

            if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri))
            {
                return false;
            }

            if (!String.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            target = new ProxyTarget
            {
                BaseUrl = uri.GetLeftPart(UriPartial.Path).TrimEnd('/'),
                Query = upstreamQuery,
                Uri = uri,
            };
            return true;
        }

        private ResolvedProxyService ResolveConfiguredService(string targetBaseUrl)
        {
            if (!Uri.TryCreate(targetBaseUrl, UriKind.Absolute, out var targetUri))
            {
                return ResolvedProxyService.Empty;
            }

            var host = targetUri.Host ?? String.Empty;
            if (host.EndsWith(VirtualGisDomain, StringComparison.OrdinalIgnoreCase))
            {
                var encryptedGuid = host.Substring(0, host.Length - VirtualGisDomain.Length);
                if (encryptedGuid.Contains('.'))
                {
                    return ResolvedProxyService.Empty;
                }

                var service = GetService(encryptedGuid);
                return service == null
                    ? ResolvedProxyService.Empty
                    : new ResolvedProxyService(service, true, targetUri.GetLeftPart(UriPartial.Authority));
            }

            // Backward compatibility for configured direct URLs. This does not
            // create an open proxy: a database match is still mandatory.
            var configuredService = GetServiceByUrl(targetBaseUrl);
            return configuredService == null
                ? ResolvedProxyService.Empty
                : new ResolvedProxyService(configuredService, false, null);
        }

        private static bool TryBuildRequestUrl(
            ProxyTarget target,
            ResolvedProxyService resolved,
            out string requestUrl)
        {
            requestUrl = null;
            var service = resolved.Service;
            if (service == null || String.IsNullOrWhiteSpace(service.Url))
            {
                return false;
            }

            if (!Uri.TryCreate(service.Url.Trim(), UriKind.Absolute, out var configuredUri))
            {
                return false;
            }

            if (!String.Equals(configuredUri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(configuredUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (resolved.IsVirtualHost)
            {
                var virtualAuthority = resolved.VirtualAuthority;
                if (String.IsNullOrWhiteSpace(virtualAuthority) ||
                    !target.BaseUrl.StartsWith(virtualAuthority, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                var suffix = target.BaseUrl.Substring(virtualAuthority.Length);
                var configuredBase = service.Url.Trim().TrimEnd('/');

                // Existing Eg URLs may be host-only aliases with operation path
                // suffixes. Avoid duplicating the configured service path when
                // the browser already carries it.
                requestUrl = suffix.StartsWith(configuredUri.AbsolutePath, StringComparison.OrdinalIgnoreCase)
                    ? configuredUri.GetLeftPart(UriPartial.Authority).TrimEnd('/') + suffix
                    : configuredBase + suffix;
            }
            else
            {
                // Direct targets are accepted only after GetServiceByUrl found a
                // configured service. Verify host equality before forwarding.
                if (!String.Equals(target.Uri.Host, configuredUri.Host, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
                requestUrl = target.BaseUrl;
            }

            if (!String.IsNullOrWhiteSpace(target.Query))
            {
                requestUrl += "?" + target.Query.TrimStart('?');
            }

            return Uri.TryCreate(requestUrl, UriKind.Absolute, out _);
        }

        private async Task<IActionResult> ForwardRequest(string requestUrl)
        {
            var client = new RestClient(requestUrl);
            var request = new RestRequest
            {
                Method = HttpMethods.IsPost(HttpContext.Request.Method)
                    ? Method.Post
                    : Method.Get,
            };

            CopyRequestHeader(request, "Accept");
            CopyRequestHeader(request, "Accept-Charset");
            CopyRequestHeader(request, "Content-Type");
            CopyRequestHeader(request, "Pragma");

            if (HttpMethods.IsPost(HttpContext.Request.Method))
            {
                using var reader = new StreamReader(HttpContext.Request.Body);
                var body = await reader.ReadToEndAsync();
                if (!String.IsNullOrEmpty(body))
                {
                    request.AddBody(body);
                }
            }

            var response = await client.ExecuteAsync(
                request,
                HttpContext.RequestAborted);

            var statusCode = response.StatusCode == 0
                ? StatusCodes.Status502BadGateway
                : (int)response.StatusCode;
            HttpContext.Response.StatusCode = statusCode;

            var contentType = String.IsNullOrWhiteSpace(response.ContentType)
                ? "application/octet-stream"
                : response.ContentType;

            if (response.RawBytes != null && ShouldReturnBytes(contentType))
            {
                return File(response.RawBytes, contentType);
            }

            var textContentType = String.IsNullOrWhiteSpace(response.ContentType)
                ? "application/json; charset=utf-8"
                : response.ContentType;
            return Content(response.Content ?? String.Empty, textContentType);
        }

        private void CopyRequestHeader(RestRequest request, string headerName)
        {
            if (!HttpContext.Request.Headers.TryGetValue(headerName, out var value))
            {
                return;
            }

            var headerValue = value.ToString();
            if (!String.IsNullOrWhiteSpace(headerValue))
            {
                request.AddHeader(headerName, headerValue);
            }
        }

        private static bool ShouldReturnBytes(string contentType)
        {
            return contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
                   contentType.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase) ||
                   contentType.StartsWith("application/vnd.", StringComparison.OrdinalIgnoreCase) ||
                   contentType.Contains("protobuf", StringComparison.OrdinalIgnoreCase) ||
                   contentType.Contains("pbf", StringComparison.OrdinalIgnoreCase);
        }

        private async Task<string> GetServiceToken(ProxyGisService service)
        {
            if (service == null || !service.RequiresSC)
            {
                return String.Empty;
            }

            var cacheKey = $"gis-token:{service.Id}";
            if (memoryCache.TryGetValue(cacheKey, out string cachedToken) &&
                !String.IsNullOrWhiteSpace(cachedToken))
            {
                return cachedToken;
            }

            if (!Uri.TryCreate(service.Url, UriKind.Absolute, out var serviceUri))
            {
                return String.Empty;
            }

            var tokenUrlPrefix = serviceUri.AbsolutePath.Contains("/webgis/", StringComparison.OrdinalIgnoreCase)
                ? "webgis"
                : "arcgis";
            var tokenUrl = $"{serviceUri.Scheme}://{serviceUri.Host}/{tokenUrlPrefix}/tokens/generateToken";
            var tokenClient = new RestClient(tokenUrl);
            var tokenRequest = new RestRequest { Method = Method.Post };
            tokenRequest.AddHeader("content-type", "application/x-www-form-urlencoded");
            tokenRequest.AddParameter(
                "application/x-www-form-urlencoded",
                $"f=json&expiration={TokenExpirationMinutes}&username={Uri.EscapeDataString(service.SCUserName ?? String.Empty)}&password={Uri.EscapeDataString(service.SCPassword ?? String.Empty)}",
                ParameterType.RequestBody);

            var tokenResponse = await tokenClient.ExecuteAsync(
                tokenRequest,
                HttpContext.RequestAborted);
            if (!tokenResponse.IsSuccessful || String.IsNullOrWhiteSpace(tokenResponse.Content))
            {
                return String.Empty;
            }

            var token = ExtractToken(tokenResponse.Content);
            if (!String.IsNullOrWhiteSpace(token))
            {
                var cacheEntryOptions = new MemoryCacheEntryOptions()
                    .SetAbsoluteExpiration(TimeSpan.FromMinutes(TokenExpirationMinutes - 1));
                memoryCache.Set(cacheKey, token, cacheEntryOptions);
            }
            return token;
        }

        private static string ExtractToken(string content)
        {
            if (String.IsNullOrWhiteSpace(content))
            {
                return String.Empty;
            }

            try
            {
                using var document = JsonDocument.Parse(content);
                if (document.RootElement.TryGetProperty("token", out var tokenElement))
                {
                    return tokenElement.GetString() ?? String.Empty;
                }
                return String.Empty;
            }
            catch (JsonException)
            {
                // Preserve compatibility with token services that return the
                // token as a plain string instead of ArcGIS JSON.
                return content.Trim().Trim('"');
            }
        }

        private static string AppendQueryParameter(string url, string key, string value)
        {
            var separator = url.Contains("?", StringComparison.Ordinal) ? "&" : "?";
            return url + separator + Uri.EscapeDataString(key) + "=" + Uri.EscapeDataString(value);
        }

        private ProxyGisService GetService(string encryptedGuid)
        {
            if (String.IsNullOrWhiteSpace(encryptedGuid))
            {
                return null;
            }

            try
            {
                var serviceResult = configServiceOperations.GetByEncryptedGuid(encryptedGuid);
                if (serviceResult.Data != null)
                {
                    return new ProxyGisService(serviceResult.Data, false);
                }

                var layerResult = gisLayerOperations.GetByEncryptedGuid(encryptedGuid);
                if (layerResult.Data != null)
                {
                    return new ProxyGisService(layerResult.Data, false);
                }

                var basemapLayerResult = gisBasemapLayerOperations.GetByEncryptedGuid(encryptedGuid);
                if (basemapLayerResult.Data != null)
                {
                    return new ProxyGisService(basemapLayerResult.Data, false);
                }

                return null;
            }
            catch
            {
                return null;
            }
        }

        private ProxyGisService GetServiceByUrl(string url)
        {
            if (String.IsNullOrWhiteSpace(url))
            {
                return null;
            }

            try
            {
                var configService = configServiceOperations.GetServiceByUrl(url);
                if (configService != null)
                {
                    return new ProxyGisService(configService, true);
                }

                var layerService = gisLayerOperations.GetLayerByUrl(url);
                if (layerService != null)
                {
                    return new ProxyGisService(layerService, true);
                }

                var basemapLayer = gisBasemapLayerOperations.GetLayerByUrl(url);
                if (basemapLayer != null)
                {
                    return new ProxyGisService(basemapLayer, true);
                }
            }
            catch
            {
                return null;
            }

            return null;
        }

        private sealed class ProxyTarget
        {
            public string BaseUrl { get; set; }
            public string Query { get; set; }
            public Uri Uri { get; set; }
        }

        private sealed class ResolvedProxyService
        {
            public static readonly ResolvedProxyService Empty = new ResolvedProxyService(null, false, null);

            public ResolvedProxyService(
                ProxyGisService service,
                bool isVirtualHost,
                string virtualAuthority)
            {
                Service = service;
                IsVirtualHost = isVirtualHost;
                VirtualAuthority = virtualAuthority;
            }

            public ProxyGisService Service { get; }
            public bool IsVirtualHost { get; }
            public string VirtualAuthority { get; }
        }
    }

    public class ProxyGisService : _BaseGisService
    {
        public ProxyGisService(_BaseGisService service, bool bypass)
        {
            if (service == null)
            {
                throw new ArgumentNullException(nameof(service));
            }

            Id = service.Id;
            Title = service.Title;
            Url = service.Url;
            RequiresSC = service.RequiresSC;
            SCUserName = service.SCUserName;
            SCPassword = service.SCPassword;
            Description = service.Description;
            AdditionalInfo = service.AdditionalInfo;
            ByPassProxy = bypass;
        }

        public bool ByPassProxy { get; set; }
    }
}
