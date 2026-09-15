using Microsoft.AspNetCore.Mvc.Filters;
using Business.Core.Common;
using Business.Core.Operations;
using Toolbox.Security.Jwt;
using UAParser;
using Business.Core.Context;
using Business.Core.Model;
using System;
using Microsoft.AspNetCore.Mvc;
using System.Linq;
using Microsoft.Extensions.Primitives;
using Api.Core.Base;

namespace Api.User.Filters
{
    public class AppRequestFilterAttribute : IActionFilter
    {
        private readonly BusinessContext dbContext;

        private AuthOperations authOperations { get; set; }
        private SessionUtils sessionUtils {get;set;}

        public AppRequestFilterAttribute(BusinessContext dbContext)
        {
            this.dbContext = dbContext;
            this.authOperations = new AuthOperations(dbContext);
            this.sessionUtils=new SessionUtils(dbContext                                                                             );
        }

        public void OnActionExecuted(ActionExecutedContext context)
        {
        }

        public void OnActionExecuting(ActionExecutingContext context)
        {
            
            var result = validateRequest(context);
            //logRequest(context, result?.Data);

            if (!result.IsSuccess)
            {
                context.Result = new ObjectResult(context.ModelState)
                {
                    Value = "403 Unauthorized",
                    StatusCode = Microsoft.AspNetCore.Http.StatusCodes.Status403Forbidden
                };
            }

        }

        protected ServiceResult<UserAccount> validateRequest(ActionExecutingContext context)
        {
            //Log request
            var request = context.HttpContext.Request;

            //var ip = request.HttpContext.Connection.RemoteIpAddress;
            StringValues ipVals = StringValues.Empty;
            request.Headers.TryGetValue("X-Forwarded-For", out ipVals);

            string ip = "";
            if (!StringValues.IsNullOrEmpty(ipVals))
            {
                ip = ipVals.ToString().TrimEnd(',').Split(',').AsEnumerable<string>().Select(s => s.Trim()).ToList().FirstOrDefault();
            }

            var iplocal = request.HttpContext.Connection.LocalIpAddress;

            var url = request.Path;
            var queryString = request.QueryString;

            return new ServiceResult<UserAccount>(ServiceResultType.Success, "Action Allowed For Anonymous User", null);
        }

       


        private void logRequest(ActionExecutingContext context, UserAccount userAccount = null)
        {
            //Log request
            var request = context.HttpContext.Request;

            var uaParser = Parser.GetDefault();
            string ua = request.Headers["User-Agent"].ToString();
            var clientInfo = uaParser.Parse(ua);

            var os = clientInfo.OS.ToString();
            var device = clientInfo.Device.ToString();
            var browser = clientInfo.UA.ToString();

            //var ip = request.HttpContext.Connection.RemoteIpAddress;
            StringValues ipVals = StringValues.Empty;
            request.Headers.TryGetValue("X-Forwarded-For", out ipVals);

            string ip = "";
            if (!StringValues.IsNullOrEmpty(ipVals))
            {
                ip = ipVals.ToString().TrimEnd(',').Split(',').AsEnumerable<string>().Select(s => s.Trim()).ToList().FirstOrDefault();
            }


        }


    }
}
