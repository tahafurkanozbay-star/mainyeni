using System;
using System.Collections.Generic;
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
using Microsoft.Extensions.Configuration;
using RestSharp;

namespace CityWorks.UserApi.Gis
{
    public class GisProxyController : _BaseUserApiController
    {
        private GisConfigServiceOperations configServiceOperations;
        private GisLayerOperations gisLayerOperations;
        private GisBasemapLayerOperations gisBasemapLayerOperations;
        private readonly IMemoryCache _memoryCache;

        public GisProxyController(IConfiguration configuration, IMemoryCache memoryCache, BusinessContext context)
        {
            this.configuration = configuration;
            this.dbContext = context;
            this.configServiceOperations = new GisConfigServiceOperations(context);
            this.gisLayerOperations = new GisLayerOperations(context);
            this.gisBasemapLayerOperations = new GisBasemapLayerOperations(context);
            this._memoryCache = memoryCache;
        }

        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/Proxy")]
        [HttpGet]
        [HttpPost]
        public async Task<IActionResult> Process()
        {
            try
            {
                if (!HttpContext.Request.QueryString.HasValue) return Ok("");

                string rawQuery = HttpContext.Request.QueryString.Value.TrimStart('?');
                string[] urlChunks = HttpContext.Request.QueryString.Value.Split("?");
                if (urlChunks.Length < 2 || string.IsNullOrWhiteSpace(urlChunks[1])) return BadRequest("GIS proxy target is missing.");

                string domainUrl = urlChunks[1];
                Uri uriResult;
                if (!Uri.TryCreate(domainUrl, UriKind.Absolute, out uriResult)) return BadRequest("GIS proxy target is invalid.");
                if (!string.Equals(uriResult.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) && !string.Equals(uriResult.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)) return BadRequest("GIS proxy scheme is not allowed.");

                var hostParts = uriResult.Host.Split('.');
                string eg = hostParts.Length >= 3 && hostParts[1].Equals("gissrv", StringComparison.OrdinalIgnoreCase) ? hostParts[0] : null;

                ProxyGisService service = null;
                if (!string.IsNullOrWhiteSpace(eg)) service = GetService(eg);
                if (service == null) service = GetServiceByUrl(domainUrl);
                if (service == null) return NotFound("GIS service is not registered.");

                string requestUrl;
                if (service.ByPassProxy)
                {
                    requestUrl = rawQuery;
                }
                else
                {
                    var egToken = eg;
                    requestUrl = domainUrl.Replace("https://" + egToken + ".gissrv.org", service.Url.Trim());

                    string tokenString = "";
                    if (service.RequiresSC)
                    {
                        if (!_memoryCache.TryGetValue(service.Id, out tokenString))
                        {
                            var tokenUrlPrefix = service.Url.Contains("/webgis/", StringComparison.OrdinalIgnoreCase) ? "webgis" : "arcgis";
                            var upstreamUri = new Uri(service.Url);
                            var protocol = service.Url.Contains("https", StringComparison.OrdinalIgnoreCase) ? "https://" : "http://";
                            var tokenUrl = protocol + upstreamUri.Host + "/" + tokenUrlPrefix + "/tokens/generateToken";
                            var tokenClient = new RestClient();
                            var tokenRequest = new RestRequest(tokenUrl) { Method = Method.Post };
                            tokenRequest.AddHeader("content-type", "application/x-www-form-urlencoded");
                            tokenRequest.AddParameter("application/x-www-form-urlencoded", $"expiration=30&username={service.SCUserName}&password={service.SCPassword}", ParameterType.RequestBody);
                            var tokenResponse = await tokenClient.ExecuteAsync(tokenRequest);
                            tokenString = tokenResponse.Content;
                            _memoryCache.Set(service.Id, tokenString, new MemoryCacheEntryOptions().SetSlidingExpiration(TimeSpan.FromMinutes(30)));
                        }
                    }

                    if (urlChunks.Length >= 3 && !string.IsNullOrWhiteSpace(urlChunks[2])) requestUrl += "?" + urlChunks[2];
                    var match = Regex.Match(requestUrl, "/[0-9]+/[0-9]+", RegexOptions.CultureInvariant);
                    if (match.Success) requestUrl = requestUrl.Replace(match.Value, "/" + match.Value.Split('/')[1]);
                    if (!string.IsNullOrEmpty(tokenString)) requestUrl += (requestUrl.Contains('?') ? "&" : "?") + "token=" + tokenString;
                }

                var client = new RestClient(requestUrl);
                var request = new RestRequest();
                switch (HttpContext.Request.Method)
                {
                    case "GET": request.Method = Method.Get; break;
                    case "POST": request.Method = Method.Post; break;
                    case "OPTIONS": request.Method = Method.Options; break;
                    case "PUT": request.Method = Method.Put; break;
                    default: return StatusCode(405, "HTTP method is not supported by GIS proxy.");
                }

                if (HttpContext.Request.Method != "GET")
                {
                    using (StreamReader stream = new StreamReader(HttpContext.Request.Body))
                    {
                        string body = await stream.ReadToEndAsync();
                        if (!string.IsNullOrEmpty(body)) request.AddBody(body);
                    }
                }

                var response = await client.ExecuteAsync(request);
                if (response.ContentType != null && (response.ContentType.Contains("image") || response.ContentType.Contains("application")))
                {
                    HttpContext.Response.ContentLength = response.ContentLength;
                    HttpContext.Response.ContentType = response.ContentType;
                    return File(response.RawBytes, response.ContentType);
                }
                return Ok(response.Content);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                Console.WriteLine(ex.Message + "\r\n--------------------------------\r\n" + ex.StackTrace);
                return StatusCode(502, "GIS service request failed.");
            }
        }

        private ProxyGisService GetService(string eg)
        {
            try
            {
                var serviceResult = configServiceOperations.GetByEncryptedGuid(eg);
                if (serviceResult.Data != null) return new ProxyGisService(serviceResult.Data, false);

                var layerResult = gisLayerOperations.GetByEncryptedGuid(eg);
                if (layerResult.Data != null) return new ProxyGisService(layerResult.Data, false);

                var basemaplayerResult = gisBasemapLayerOperations.GetByEncryptedGuid(eg);
                if (basemaplayerResult.Data != null) return new ProxyGisService(basemaplayerResult.Data, false);
                return null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private ProxyGisService GetServiceByUrl(string url)
        {
            ProxyGisService service = null;
            var configService = configServiceOperations.GetServiceByUrl(url);
            if (configService != null) service = new ProxyGisService(configService, true);
            var layerService = gisLayerOperations.GetLayerByUrl(url);
            if (layerService != null) service = new ProxyGisService(layerService, true);
            var basemapLayer = gisBasemapLayerOperations.GetLayerByUrl(url);
            if (basemapLayer != null) service = new ProxyGisService(basemapLayer, true);
            return service;
        }
    }

    public class ProxyGisService : _BaseGisService
    {
        public ProxyGisService(_BaseGisService service, bool bypass)
        {
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
