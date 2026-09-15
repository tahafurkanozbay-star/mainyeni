using Business.Core.Common;
using Business.Core.ViewModel;
using System;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Business.Core.Context;
using System.Collections.Generic;
using System.IdentityModel.Tokens.Jwt;
using Business.Core.Model;
using Toolbox.Security.Jwt;
using Business.Core.Operations;
using System.Linq;
using Toolbox.Serialization;
using UAParser;
using Microsoft.Extensions.Primitives;
using Business.Core.Resources;
using Microsoft.Extensions.Configuration;

namespace Api.Core.Base
{
    [ApiController]
    public abstract class _BaseController : ControllerBase
    {
        protected BusinessContext dbContext { get; set; }
        protected IConfiguration configuration { get; set; }


        protected Dictionary<string, string> getAllHeaders()
        {
            Dictionary<string, string> requestHeaders =
                new Dictionary<string, string>();

            foreach (var header in Request.Headers)
            {
                requestHeaders.Add(header.Key, header.Value);
            }

            return requestHeaders;
        }



        protected ClientRequestInfo GetClientRequestInfo()
        {
            var uaParser = Parser.GetDefault();

            var request = HttpContext.Request;
            //var ip = request.HttpContext.Connection.RemoteIpAddress;
            StringValues ipVals = StringValues.Empty;
            request.Headers.TryGetValue("X-Forwarded-For", out ipVals);

            string ip = "";
            if (!StringValues.IsNullOrEmpty(ipVals))
            {
                ip = ipVals.ToString().TrimEnd(',').Split(',').AsEnumerable<string>().Select(s => s.Trim()).ToList().FirstOrDefault();
            }


            var iplocal = request.HttpContext.Connection.LocalIpAddress;

            string ua = request.Headers["User-Agent"].ToString();
            var clientInfo = uaParser.Parse(ua);

            var os = clientInfo.OS.ToString();
            var device = clientInfo.Device.ToString();
            var browser = clientInfo.UA.ToString();

            return new ClientRequestInfo()
            {
                Os = os,
                Device = device,
                Browser = browser,
                Ip = ip.ToString(),
                IpLocal = iplocal.ToString()
            };
        }


        protected void handleExceptionResult(Exception ex, int userId = -1)
        {
            try
            {
                var bx = new Business.Core.Model.BusinessException()
                {
                    Message = ex.Message,
                    Source = ex.Source,
                    StackTrace = ex.StackTrace,
                };


                bx.SetCreate(userId);
                dbContext.BusinessExceptions.Add(bx);
                dbContext.SaveChanges();

                if (ex.InnerException != null)
                {
                    handleExceptionResult(ex.InnerException, userId);
                }


            }
            catch (Exception exx)
            {
            
                var fileName = Configuration.FILE_EXCEPTION_LOG_PATH + "/exceptionlog_" + DateTime.Now.ToString("yyyyMMddHHmmss") + ".txt";
                if (!System.IO.Directory.Exists(Configuration.FILE_EXCEPTION_LOG_PATH))
                {
                    System.IO.Directory.CreateDirectory(Configuration.FILE_EXCEPTION_LOG_PATH);
                }
                System.IO.File.WriteAllText(fileName, SerializationUtils.ObjectToJson(ex));
                System.IO.File.AppendAllText(fileName, SerializationUtils.ObjectToJson(exx));

                throw;
            }
        }

        protected ServiceResult exceptionResult(Exception ex)
        {
            if (Configuration.DEBUG_MODE)
            {
                if (ex.InnerException != null)
                {
                    return exceptionResult(ex.InnerException);
                }
                else
                {
                    return new ServiceResult(ServiceResultType.Error, ex.Message + "\n Stacktrace:" + ex.StackTrace);
                }

            }
            else
            {
                return new ServiceResult(ServiceResultType.Error, "Bir hata oluştu");
            }
        }


        /// <summary>
        /// Header içerisideki bearer token bilgisinden session info bilgisini döndürür
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>
        protected ServiceResult<UserSessionViewModel> GetSession(HttpContext context)
        {
            try
            {
                var tokenInfo = context.Request.Headers["Authorization"].ToString();
                if (String.IsNullOrEmpty(tokenInfo))
                {
                    return new ServiceResult<UserSessionViewModel>(ServiceResultType.Error, "Invalid Token", null);
                }

                var sessionUtils = new SessionUtils(dbContext);
                UserAccount account = sessionUtils.getUserAccountFromToken(tokenInfo);
                if (account != null)
                {
                    UserSessionViewModel viewModel = new UserSessionViewModel()
                    {
                        FirstName = account.FirstName,
                        LastName = account.LastName,
                        UserId = account.Id,    
                        Eg = account.Guid,
                        Roles = account.Roles,
                    };

                    return new ServiceResult<UserSessionViewModel>(ServiceResultType.Success, viewModel);
                }
                else
                {

                    return new ServiceResult<UserSessionViewModel>(ServiceResultType.Error, BusinessMessages.Get("NOT_AUTHORIZED"), null);
                }
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new ServiceResult<UserSessionViewModel>(ServiceResultType.Error, BusinessMessages.Get("NOT_AUTHORIZED"), null);
            }
        }

    }
}