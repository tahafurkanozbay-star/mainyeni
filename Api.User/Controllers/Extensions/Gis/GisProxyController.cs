using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis._Base;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using RestSharp;

namespace CityWorks.UserApi.Gis
{
    public class GisProxyController : _BaseUserApiController
    {
        private const string ServiceHostSuffix = ".gissrv.org";
        private const int RequestTimeoutMs = 15000;
        private const int TokenLifetimeMinutes = 30;

        private readonly GisConfigServiceOperations configServiceOperations;
        private readonly GisLayerOperations gisLayerOperations;
        private readonly GisBasemapLayerOperations gisBasemapLayerOperations;
        private readonly IMemoryCache memoryCache;

        public GisProxyController(IMemoryCache memoryCache, BusinessContext context)
        {
            this.configServiceOperations = new GisConfigServiceOperations(context);
            this.gisLayerOperations = new GisLayerOperations(context);
            this.gisBasemapLayerOperations = new GisBasemapLayerOperations(context);
            this.memoryCache = memoryCache;
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

                if (HttpContext.Request.Method == "POST" &&
                    HttpContext.Request.ContentLength.HasValue &&
                    HttpContext.Request.ContentLength.Value > 5 * 1024 * 1024)
                {
                    return StatusCode(413, "Proxy request body is too large.");
                }

                var rawQuery = HttpContext.Request.QueryString.Value?.TrimStart('?') ?? string.Empty;
                var separatorIndex = rawQuery.IndexOf('?');
                var domainUrl = separatorIndex >= 0 ? rawQuery.Substring(0, separatorIndex) : rawQuery;
                var forwardedQuery = separatorIndex >= 0 ? rawQuery.Substring(separatorIndex + 1) : string.Empty;

                if (!TryExtractServiceId(domainUrl, out var serviceId))
                {
                    return BadRequest("Invalid proxy target.");
                }

                // Never fall back to arbitrary URL matching. The encrypted service
                // identifier is the only public routing handle accepted by this proxy.
                var service = GetService(serviceId);
                if (service == null)
                {
                    return NotFound();
                }

                var upstreamUri = BuildUpstreamUri(service.Url, forwardedQuery);
                if (upstreamUri == null)
                {
                    return BadRequest("Configured GIS service URL is invalid.");
                }

                if (service.RequiresSC)
                {
                    var token = await GetServiceToken(service);
                    if (string.IsNullOrWhiteSpace(token))
                    {
                        return StatusCode(502, "GIS service authentication failed.");
                    }
                    upstreamUri = AppendQueryParameter(upstreamUri, "token", token);
                }

                var clientOptions = new RestClientOptions
                {
                    MaxTimeout = RequestTimeoutMs
                };
                var client = new RestClient(clientOptions);
                var request = new RestRequest(upstreamUri.ToString());
                request.Method = HttpContext.Request.Method == "POST" ? Method.Post : Method.Get;
                request.AddHeader("Accept", HttpContext.Request.Headers.Accept.ToString());

                if (request.Method == Method.Post)
                {
                    request.AddHeader("Content-Type", HttpContext.Request.ContentType ?? "application/json");
                    using (var stream = new StreamReader(HttpContext.Request.Body))
                    {
                        request.AddStringBody(await stream.ReadToEndAsync(), DataFormat.Json);
                    }
                }

                var response = await client.ExecuteAsync(request, HttpContext.RequestAborted);
                if (!response.IsSuccessful && string.IsNullOrWhiteSpace(response.Content))
                {
                    return StatusCode((int)response.StatusCode, "GIS service request failed.");
                }

                if (!string.IsNullOrWhiteSpace(response.ContentType) &&
                    (response.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
                     response.ContentType.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase)))
                {
                    HttpContext.Response.ContentType = response.ContentType;
                    return File(response.RawBytes ?? Array.Empty<byte>(), response.ContentType);
                }

                HttpContext.Response.ContentType = string.IsNullOrWhiteSpace(response.ContentType)
                    ? "application/json"
                    : response.ContentType;
                return Content(response.Content ?? string.Empty, HttpContext.Response.ContentType);
            }
            catch (OperationCanceledException)
            {
                return new EmptyResult();
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return StatusCode(502, "GIS service is temporarily unavailable.");
            }
        }

        private bool TryExtractServiceId(string domainUrl, out string serviceId)
        {
            serviceId = null;
            if (!Uri.TryCreate(domainUrl, UriKind.Absolute, out var uri) ||
                !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!uri.Host.EndsWith(ServiceHostSuffix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var prefix = uri.Host.Substring(0, uri.Host.Length - ServiceHostSuffix.Length).TrimEnd('.');
            if (string.IsNullOrWhiteSpace(prefix) || prefix.Contains('.'))
            {
                return false;
            }

            serviceId = prefix;
            return true;
        }

        private Uri BuildUpstreamUri(string configuredUrl, string forwardedQuery)
        {
            if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var baseUri) ||
                (baseUri.Scheme != Uri.UriSchemeHttps && baseUri.Scheme != Uri.UriSchemeHttp))
            {
                return null;
            }

            var builder = new UriBuilder(baseUri);
            if (!string.IsNullOrWhiteSpace(forwardedQuery))
            {
                var query = forwardedQuery.TrimStart('?');
                builder.Query = string.IsNullOrWhiteSpace(builder.Query)
                    ? query
                    : builder.Query.TrimStart('?') + "&" + query;
            }

            var result = builder.Uri;
            var path = result.AbsolutePath;
            var match = Regex.Match(path, @"/[0-9]+/[0-9]+");
            if (match.Success)
            {
                var replacement = "/" + match.Value.Split('/')[1];
                builder.Path = path.Replace(match.Value, replacement);
            }

            return builder.Uri;
        }

        private static Uri AppendQueryParameter(Uri uri, string name, string value)
        {
            var builder = new UriBuilder(uri);
            var separator = string.IsNullOrWhiteSpace(builder.Query) ? "" : "&";
            builder.Query = builder.Query.TrimStart('?') + separator +
                Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(value);
            return builder.Uri;
        }

        private ProxyGisService GetService(string encryptedServiceId)
        {
            try
            {
                var serviceResult = configServiceOperations.GetByEncryptedGuid(encryptedServiceId);
                if (serviceResult.Data != null)
                {
                    return new ProxyGisService(serviceResult.Data);
                }

                var layerResult = gisLayerOperations.GetByEncryptedGuid(encryptedServiceId);
                if (layerResult.Data != null)
                {
                    return new ProxyGisService(layerResult.Data);
                }

                var basemapResult = gisBasemapLayerOperations.GetByEncryptedGuid(encryptedServiceId);
                if (basemapResult.Data != null)
                {
                    return new ProxyGisService(basemapResult.Data);
                }

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
            var cacheKey = $"gis-token:{service.Url}";
            if (memoryCache.TryGetValue(cacheKey, out string cachedToken))
            {
                return cachedToken;
            }

            if (!Uri.TryCreate(service.Url, UriKind.Absolute, out var serviceUri))
            {
                return null;
            }

            var tokenHostPrefix = service.Url.Contains("/webgis/", StringComparison.OrdinalIgnoreCase)
                ? "webgis"
                : "arcgis";
            var tokenUrl = $"{serviceUri.Scheme}://{serviceUri.Host}/{tokenHostPrefix}/tokens/generateToken";

            var tokenClient = new RestClient(new RestClientOptions { MaxTimeout = RequestTimeoutMs });
            var tokenRequest = new RestRequest(tokenUrl, Method.Post);
            tokenRequest.AddHeader("Content-Type", "application/x-www-form-urlencoded");
            tokenRequest.AddParameter("expiration", TokenLifetimeMinutes * 60);
            tokenRequest.AddParameter("username", service.SCUserName);
            tokenRequest.AddParameter("password", service.SCPassword);

            var response = await tokenClient.ExecuteAsync(tokenRequest, HttpContext.RequestAborted);
            if (!response.IsSuccessful || string.IsNullOrWhiteSpace(response.Content))
            {
                return null;
            }

            var token = response.Content.Trim();
            memoryCache.Set(cacheKey, token, TimeSpan.FromMinutes(TokenLifetimeMinutes));
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
