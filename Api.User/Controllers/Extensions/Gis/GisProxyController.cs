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

                if (!GisProxyTargetPolicy.TryParsePublicTarget(
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

                var upstreamUri = GisProxyTargetPolicy.BuildUpstreamUri(service.Url, publicTarget, forwardedQuery);
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
                    upstreamUri = GisProxyTargetPolicy.SetQueryParameter(upstreamUri, "token", token);
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

                // External ArcGIS services must never become a same-origin
                // HTML, SVG or script document via the authenticated proxy.
                // API security headers intentionally omit their CSP for HTML.
                if (GisProxyPayloadPolicy.IsActiveContentType(response.ContentType))
                {
                    return StatusCode(
                        StatusCodes.Status502BadGateway,
                        "GIS service returned an unsupported active content type.");
                }

                if (!string.IsNullOrWhiteSpace(response.ContentType) &&
                    (response.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
                     response.ContentType.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase)))
                {
                    return File(response.RawBytes ?? Array.Empty<byte>(), response.ContentType);
                }

                var responseType = GisProxyPayloadPolicy.NormalizeResponseContentType(response.ContentType);
                if (string.Equals(responseType, "application/octet-stream", StringComparison.OrdinalIgnoreCase))
                {
                    // Unknown media types are download-only; preserve binary bytes instead
                    // of re-encoding RestSharp's decoded string representation.
                    var bytes = response.RawBytes ??
                        System.Text.Encoding.UTF8.GetBytes(response.Content ?? string.Empty);
                    return File(bytes, responseType);
                }
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

        private Task<string?> ReadBoundedBody()
        {
            // Content-Length is optional for chunked requests; limit bytes while
            // consuming rather than materializing an unbounded request first.
            return GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
                HttpContext.Request.Body,
                MaxRequestBodyBytes,
                HttpContext.RequestAborted);
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

            var cacheKey = GisProxyTokenCacheKeyPolicy.Create(
                service.Url, service.SCUserName, service.SCPassword);
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

            var tokenUrl = GisProxyTokenEndpointPolicy.Create(serviceUri).ToString();

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