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

        public GisProxyController(IConfiguration configuration, IMemoryCache memoryCache ,BusinessContext context)
        {
            this.configuration = configuration;
            this.dbContext = context;
            this.configServiceOperations = new GisConfigServiceOperations(context);
            this.gisLayerOperations = new GisLayerOperations(context);
            this.gisBasemapLayerOperations=new GisBasemapLayerOperations(context);
            this._memoryCache=memoryCache;
        }


        private void writeLog(string url, DateTime startTime, DateTime endTime, string description){
            
            var timeDiff=endTime-startTime;

            var message="T: "+timeDiff.TotalSeconds+" / "+ description+" - " + url+ " / START: "+startTime.ToString("dd/MM/yyyy HH:mm:ss")+ " / END: "+endTime.ToString("dd/MM/yyyy HH:mm:ss");
            handleExceptionResult(new Exception(message),-1);
        }

        /// <summary>
        /// Gets the list for configuration services
        /// </summary>
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/Proxy")]
        [HttpGet]
        [HttpPost]
        public async Task<IActionResult> Process()
        {
            try
            {

                /*
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }
                */

             

                if (!HttpContext.Request.QueryString.HasValue)
                {
                    return Ok("");
                }

                string rawUrl= HttpContext.Request.QueryString.Value.TrimStart('?');
                string[] urlChunks = HttpContext.Request.QueryString.Value.Split("?");
                string domainUrl = urlChunks[1];

                Uri uriResult;
                Uri.TryCreate(domainUrl, UriKind.Absolute, out uriResult);

                string eg = domainUrl.Split("https://")[1].Split(".")[0];
                //string eg=uriResult.Host.Split(".")[0]; //base 64 stringi küçülttüğü için kullanmıyoruz

                //TODO: Header auth check

                //Find service from db with eg
                var dbTime_Start= DateTime.Now;
                
                var service = GetService(eg);
                if (service == null)
                {
                    service = GetServiceByUrl(domainUrl);

                    if (service == null)
                    {
                        return NotFound();
                    }
                }

                var dbTime_End= DateTime.Now;
                //writeLog(eg,dbTime_Start,dbTime_End,"db request");

                //Replace Eg with Actual Url 
                var requestUrl = "";

                if (service.ByPassProxy)
                {
                    requestUrl= rawUrl;
                }
                else{
                     requestUrl = domainUrl.Replace("https://" + eg + ".gissrv.org", service.Url.Trim());

                    var tokenString = "";
                    if (service.RequiresSC)
                    {
                        if(_memoryCache.TryGetValue(service.Id, out string _tokenString)){
                            tokenString=_tokenString;
                        }
                        else{
                            var tokenClient = new RestClient();
                            string tokenUrlPrefix = "arcgis";

                            if (service.Url.Contains("/webgis/"))
                            {
                                tokenUrlPrefix = "webgis";
                            }

                            int expirationTime = 30;
                            var _tokenUrl = new Uri(service.Url);
                            var _tokenUrlProtocol = service.Url.Contains("https") ? "https://" : "http://";
                            var tokenUrl = _tokenUrlProtocol + _tokenUrl.Host + "/" + tokenUrlPrefix + "/tokens/generateToken";

                            var token = new
                            {
                                Username = service.SCUserName,
                                Password = service.SCPassword
                            };

                            var tokenRequest = new RestRequest(tokenUrl);
                            
                            //System.Console.WriteLine(tokenUrl);
                            tokenRequest.Method = Method.Post;
                            tokenRequest.AddHeader("content-type", "application/x-www-form-urlencoded");

                            tokenRequest.AddParameter("application/x-www-form-urlencoded", $"expiration={expirationTime}&username={service.SCUserName}&password={service.SCPassword}", ParameterType.RequestBody);

                            var tokenResponse = await tokenClient.ExecuteAsync(tokenRequest);

                            tokenString = tokenResponse.Content;

                            var cacheEntryOptions = new MemoryCacheEntryOptions().SetSlidingExpiration(TimeSpan.FromMinutes(30));
                            _memoryCache.Set(service.Id, tokenString, cacheEntryOptions);

                            }
                        
                        //System.Console.WriteLine("tokenString: "+tokenString);
                    }


                    //Add Query String
                    if (urlChunks.Length >= 3)
                    {
                        var queryStr = urlChunks[2];
                        requestUrl += "?" + queryStr;
                    }

                    //    ....url/2/2/query? ... şeklinde gelen url i ....url/2/query.... şekline dönüştürür 
                    string regext = "/[0-9]+/[0-9]+";
                    var matches = Regex.Matches(requestUrl, regext);
                    if (matches?.Count > 0)
                    {
                        string matchValue = matches[0].Value;
                        string replacementtext = "/" + matchValue.Split("/")[1];
                        requestUrl = Regex.Replace(requestUrl, regext, replacementtext);
                    }

                    //If there is a token
                    if (!String.IsNullOrEmpty(tokenString))
                    {
                        requestUrl += "&token=" + tokenString;
                    }
                }


                var client = new RestClient(requestUrl);

                var request = new RestRequest();
                switch (HttpContext.Request.Method)
                {
                    case "GET":
                        request.Method = Method.Get;
                        break;

                    case "POST":
                        request.Method = Method.Post;
                        request.AddHeader("Accept", HttpContext.Request.Headers.Accept);
                        request.AddHeader("Accept-Charset", HttpContext.Request.Headers.AcceptCharset);
                        request.AddHeader("Accept-Encoding", HttpContext.Request.Headers.AcceptEncoding);

                        request.AddHeader("Pragma", HttpContext.Request.Headers.Pragma);
                        request.AddHeader("Content-Type", HttpContext.Request.Headers.ContentType);
                        request.AddHeader("Content-Length", HttpContext.Request.Headers.ContentLength.ToString());

                        break;

                    case "OPTIONS":
                        request.Method = Method.Options;
                        break;

                    case "PUT":
                        request.Method = Method.Put;
                        break;
                    default:
                        break;
                }


                //write request body
                using (StreamReader stream = new StreamReader(HttpContext.Request.Body))
                {
                    string body = await stream.ReadToEndAsync();

                    request.AddBody(body);

                    //request.AddStringBody(body, DataFormat.Json);
                }

                var serviceTime_Start= DateTime.Now;
                
                var response = await client.ExecuteAsync(request);

                var serviceTime_End= DateTime.Now;
                //writeLog(requestUrl,serviceTime_Start,serviceTime_End,"service request");

                if (response.ContentType != null && (response.ContentType.Contains("image") || response.ContentType.Contains("application")))
                {
                    HttpContext.Response.ContentLength = response.ContentLength;
                    HttpContext.Response.ContentType = response.ContentType;
                    var bytes = response.RawBytes;
                    return File(bytes, response.ContentType);
                }
                else
                {

                    return Ok(response.Content);
                }
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                Console.WriteLine(ex.Message + " \r\n" + " -------------------------------- " + " \r\n");
                Console.WriteLine(ex.StackTrace);
                return Ok("An error occured");
            }
        }

        private ProxyGisService GetService(string eg)
        {
            //TODO: find service
            try
            {
                var serviceResult = configServiceOperations.GetByEncryptedGuid(eg);
                if (serviceResult.Data != null)
                {
                    return new ProxyGisService(serviceResult.Data, false);
                }

                var layerResult = gisLayerOperations.GetByEncryptedGuid(eg);
                if (layerResult.Data != null)
                {
                    //bool bypass = layerResult.Data.IsCustomLayer;
                    return new ProxyGisService(layerResult.Data, false);
                }


                var basemaplayerResult = gisBasemapLayerOperations.GetByEncryptedGuid(eg);
                if (basemaplayerResult.Data != null)
                {
                    return new ProxyGisService(layerResult.Data, false);
                }

                return null;    
            }
            catch (System.Exception ex)
            {
                return null;    
            }
        
        }


        private static List<ProxyGisService> serviceCache=new List<ProxyGisService>();
        private ProxyGisService GetServiceByUrl(string _url)
        {
            
            ProxyGisService pService=null;
            /*
            var cacheHit= serviceCache.Where(x=> x.Url.Contains(_url) || _url.Contains(x.Url)).FirstOrDefault();
            if(cacheHit!=null){
                return cacheHit;
            }
            */

            var configService = configServiceOperations.GetServiceByUrl(_url);
            if (configService != null)
            {
                pService=new ProxyGisService(configService, true);
            }

            var layerService = gisLayerOperations.GetLayerByUrl(_url);
            if (layerService != null)
            {
                pService =new ProxyGisService(layerService, true);
            }

            var basemaplayer = gisBasemapLayerOperations.GetLayerByUrl(_url);
            if (basemaplayer!= null)
            {
                pService= new ProxyGisService(basemaplayer, true);
            }

            /*
            if(pService!=null){
                serviceCache.Add(pService);
            }
            */

            return pService;
        }
    }


    public class ProxyGisService : _BaseGisService
    {
        public ProxyGisService(_BaseGisService _service, bool bypass)
        {
            Title = _service.Title;
            Url = _service.Url;
            RequiresSC = _service.RequiresSC;
            SCUserName = _service.SCUserName;
            SCPassword = _service.SCPassword;
            Description = _service.Description;
            AdditionalInfo = _service.AdditionalInfo;
            ByPassProxy = bypass;
        }

        public bool ByPassProxy { get; set; }

    }

}
