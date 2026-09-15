using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis._Base;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using RestSharp;
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace CityWorks.UserApi.Gis
{
    public class GisProxyController : _BaseUserApiController
    {
        private const string ServiceHostSuffix = ".gissrv.org";
        private const int RequestTimeoutMs = 15_000;
        private const int TokenLifetimeMinutes = 30;
        private const long MaxRequestBodyBytes = 5 * 1024 * 1024;
        private const int MaxForwardedQueryLength = 16 * 1024;

        private readonly GisConfigServiceOperations configServiceOperations;
        private readonly GisLayerOperations gisLayerOperations;
        private readonly GisBasemapLayerOperations gisBasemapLayerOperations;
        private readonly IMemoryCache memoryCache;

        public GisProxyController(IMemoryCache memoryCache, BusinessContext context)
        {
            this.memoryCache = memoryCache ?? throw new ArgumentNullException(nameof(memoryCache));
            configServiceOperations = new GisConfigServiceOperations(context);
            gisLayerOperations = new GisLayerOperations(context);
            gisBasemapLayerOperations = new GisBasemapLayerOperations(context);
        }

        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/Proxy")]
        [HttpGet]
        [HttpPost]
        public async Task<IActionResult> Process()
        {
            try
            {
                if (!HttpContext.Request.QueryString.HasValue)
                {
                    return BadRequest("Proxy target is required.");
                }

                if (HttpContext.Request.ContentLength.GetValueOrDefault() > MaxRequestBodyBytes)
                {
                    return StatusCode(StatusCodes.Status413PayloadTooLarge, "Proxy request body is too large.");
                }

                if (!TryParsePublicTarget(
                        HttpContext.Request.QueryString.Value,
                        out var publicTarget,
                        out var serviceId,
                        out var forwardedQuery))
                {
                    return BadRequest("Invalid proxy target.");
                }

                if (forwardedQuery.Length > MaxForwardedQueryLength)
                {
                    return BadRequest("Proxy query is too large.");
                }

                // The browser can address only an opaque service id that resolves to a server-owned
                // database record. There is deliberately no raw URL lookup/bypass fallback.
                var service = GetService(serviceId);
                if (service == null)
                {
                    return NotFound();
                }

                var upstreamUri = BuildUpstreamUri(service.Url, publicTarget, forwardedQuery);
                if (upstreamUri == null)
                {
                    return BadRequest("Configured GIS service URL is invalid.");
                }

                if (service.RequiresSC)
                {
                    var token = await GetServiceToken(service);
                    if (string.IsNullOrWhiteSpace(token))
                    {
                        return StatusCode(StatusCodes.Status502BadGateway, "GIS service authentication failed.");
                    }
                    upstreamUri = AppendQueryParameter(upstreamUri, "token", token);
                }

                var client = new RestClient(new RestClientOptions
                {
                    Timeout = TimeSpan.FromMilliseconds(RequestTimeoutMs)
                });
                var request = new RestRequest(upstreamUri.ToString())
                {
                    Method = HttpContext.Request.Method == HttpMethods.Post ? Method.Post : Method.Get
                };

                if (!string.IsNullOrWhiteSpace(HttpContext.Request.Headers.Accept))
                {
                    request.AddHeader("Accept", HttpContext.Request.Headers.Accept.ToString());
                }

                if (request.Method == Method.Post)
                {
                    var body = await ReadBoundedBody();
                    if (body == null)
                    {
                        return StatusCode(StatusCodes.Status413PayloadTooLarge, "Proxy request body is too large.");
                    }

                    var contentType = NormalizeContentType(HttpContext.Request.ContentType);
                    request.AddParameter(contentType, body, ParameterType.RequestBody);
                }

                var response = await client.ExecuteAsync(request, HttpContext.RequestAborted);
                if (response.ResponseStatus != ResponseStatus.Completed)
                {
                    return StatusCode(StatusCodes.Status502BadGateway, "GIS service request failed.");
                }

                var upstreamStatus = (int)response.StatusCode;
                if (upstreamStatus < 200 || upstreamStatus >= 300)
                {
                    return StatusCode(
                        upstreamStatus > 0 ? upstreamStatus : StatusCodes.Status502BadGateway,
                        "GIS service request failed.");
                }

                if (!string.IsNullOrWhiteSpace(response.ContentType) &&
                    (response.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
                     response.ContentType.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase)))
                {
                    return File(response.RawBytes ?? Array.Empty<byte>(), response.ContentType);
                }

                var responseType = NormalizeResponseContentType(response.ContentType);
                return Content(response.Content ?? string.Empty, responseType);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return new EmptyResult();
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return StatusCode(StatusCodes.Status502BadGateway, "GIS service is temporarily unavailable.");
            }
        }

        private static bool TryParsePublicTarget(
            string rawQueryString,
            out Uri publicTarget,
            out string serviceId,
            out string forwardedQuery)
        {
            publicTarget = null;
            serviceId = null;
            forwardedQuery = string.Empty;

            var raw = (rawQueryString ?? string.Empty).TrimStart('?').Trim();
            if (string.IsNullOrWhiteSpace(raw)) return false;

            var querySeparator = raw.IndexOf('?');
            var targetText = querySeparator >= 0 ? raw.Substring(0, querySeparator) : raw;
            forwardedQuery = querySeparator >= 0 ? raw.Substring(querySeparator + 1) : string.Empty;

            if (!Uri.TryCreate(targetText, UriKind.Absolute, out var target) ||
                !string.Equals(target.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                !target.Host.EndsWith(ServiceHostSuffix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var hostPrefix = target.Host
                .Substring(0, target.Host.Length - ServiceHostSuffix.Length)
                .TrimEnd('.');
            if (string.IsNullOrWhiteSpace(hostPrefix) || hostPrefix.Contains('.'))
            {
                return false;
            }

            var decodedPath = Uri.UnescapeDataString(target.AbsolutePath);
            if (decodedPath.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment => segment == ".."))
            {
                return false;
            }

            publicTarget = target;
            serviceId = hostPrefix;
            return true;
        }

        private static Uri BuildUpstreamUri(string configuredUrl, Uri publicTarget, string forwardedQuery)
        {
            if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var configured) ||
                (configured.Scheme != Uri.UriSchemeHttps && configured.Scheme != Uri.UriSchemeHttp))
            {
                return null;
            }

            var builder = new UriBuilder(configured);
            var basePath = builder.Path.TrimEnd('/');
            var suffixPath = publicTarget.AbsolutePath;

            // ArcGIS may append the layer id already present in a configured layer URL.
            var baseLastSegment = basePath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
            var suffixSegments = suffixPath.Split('/', StringSplitOptions.RemoveEmptyEntries).ToList();
            if (suffixSegments.Count > 0 &&
                int.TryParse(baseLastSegment, out _) &&
                string.Equals(baseLastSegment, suffixSegments[0], StringComparison.Ordinal))
            {
                suffixSegments.RemoveAt(0);
            }

            builder.Path = suffixSegments.Count == 0
                ? basePath
                : basePath + "/" + string.Join('/', suffixSegments);

            var existingQuery = builder.Query.TrimStart('?');
            builder.Query = string.IsNullOrWhiteSpace(existingQuery)
                ? forwardedQuery
                : string.IsNullOrWhiteSpace(forwardedQuery)
                    ? existingQuery
                    : existingQuery + "&" + forwardedQuery;

            return builder.Uri;
        }

        private static Uri AppendQueryParameter(Uri uri, string name, string value)
        {
            var builder = new UriBuilder(uri);
            var existing = builder.Query.TrimStart('?');
            var next = Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(value);
            builder.Query = string.IsNullOrWhiteSpace(existing) ? next : existing + "&" + next;
            return builder.Uri;
        }

        private async Task<string> ReadBoundedBody()
        {
            using var reader = new StreamReader(HttpContext.Request.Body);
            var body = await reader.ReadToEndAsync();
            return System.Text.Encoding.UTF8.GetByteCount(body) <= MaxRequestBodyBytes ? body : null;
        }

        private static string NormalizeContentType(string contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType)) return "application/x-www-form-urlencoded";
            var mediaType = contentType.Split(';')[0].Trim().ToLowerInvariant();
            return mediaType switch
            {
                "application/json" => "application/json",
                "application/x-www-form-urlencoded" => "application/x-www-form-urlencoded",
                "text/plain" => "text/plain",
                _ => "application/octet-stream"
            };
        }

        private static string NormalizeResponseContentType(string contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType)) return "application/json; charset=utf-8";
            return contentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) ||
                   contentType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)
                ? contentType
                : "application/octet-stream";
        }

        private ProxyGisService GetService(string encryptedServiceId)
        {
            try
            {
                var configService = configServiceOperations.GetByEncryptedGuid(encryptedServiceId).Data;
                if (configService != null) return new ProxyGisService(configService);

                var layer = gisLayerOperations.GetByEncryptedGuid(encryptedServiceId).Data;
                if (layer != null) return new ProxyGisService(layer);

                var basemap = gisBasemapLayerOperations.GetByEncryptedGuid(encryptedServiceId).Data;
                if (basemap != null) return new ProxyGisService(basemap);

                return null;
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return null;
            }
        }

        private async Task<string> GetServiceToken(ProxyGisService service)
        {
            if (string.IsNullOrWhiteSpace(service.SCUserName) || string.IsNullOrWhiteSpace(service.SCPassword))
            {
                return null;
            }

            var cacheKey = $"gis-token:{service.Url}";
            if (memoryCache.TryGetValue(cacheKey, out string cachedToken))
            {
                return cachedToken;
            }

            if (!Uri.TryCreate(service.Url, UriKind.Absolute, out var serviceUri) ||
                serviceUri.Scheme != Uri.UriSchemeHttps)
            {
                // Never send upstream service credentials over clear-text HTTP.
                return null;
            }

            var tokenHostPrefix = service.Url.Contains("/webgis/", StringComparison.OrdinalIgnoreCase)
                ? "webgis"
                : "arcgis";
            var tokenUrl = $"{serviceUri.Scheme}://{serviceUri.Host}/{tokenHostPrefix}/tokens/generateToken";

            var tokenClient = new RestClient(new RestClientOptions
            {
                Timeout = TimeSpan.FromMilliseconds(RequestTimeoutMs)
            });
            var tokenRequest = new RestRequest(tokenUrl, Method.Post);
            tokenRequest.AddParameter("f", "json");
            tokenRequest.AddParameter("expiration", TokenLifetimeMinutes);
            tokenRequest.AddParameter("username", service.SCUserName);
            tokenRequest.AddParameter("password", service.SCPassword);

            var response = await tokenClient.ExecuteAsync(tokenRequest, HttpContext.RequestAborted);
            if (!response.IsSuccessful || string.IsNullOrWhiteSpace(response.Content))
            {
                return null;
            }

            string token;
            try
            {
                using var document = JsonDocument.Parse(response.Content);
                token = document.RootElement.TryGetProperty("token", out var tokenElement)
                    ? tokenElement.GetString()
                    : null;
            }
            catch (JsonException)
            {
                return null;
            }

            if (string.IsNullOrWhiteSpace(token)) return null;

            memoryCache.Set(cacheKey, token, TimeSpan.FromMinutes(TokenLifetimeMinutes - 2));
            return token;
        }
    }

    public class ProxyGisService : _BaseGisService
    {
        public ProxyGisService(_BaseGisService service)
        {
            Title = service.Title;
            Url = service.Url;
            RequiresSC = service.RequiresSC;
            SCUserName = service.SCUserName;
            SCPassword = service.SCPassword;
            Description = service.Description;
            AdditionalInfo = service.AdditionalInfo;
        }
    }
}