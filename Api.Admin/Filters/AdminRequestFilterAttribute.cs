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

namespace Api.Admin.Filters
{

    ///Bu attribute admin tarafındaki requestleri filtrelemeye yarar
    public class AdminRequestFilterAttribute : IActionFilter
    {
        private readonly BusinessContext dbContext;

        private AuthOperations authOperations { get; set; }
        private SessionUtils sessionUtils {get;set;}

        public AdminRequestFilterAttribute(BusinessContext dbContext)
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
            logRequest(context, result?.Data);

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


            UserAccount userAccount = null;

            bool tokenValidated = false;
            var tokenInfo = context.HttpContext.Request.Headers["Authorization"].ToString();
            if (String.IsNullOrEmpty(tokenInfo))
            {
                return new ServiceResult<UserAccount>(ServiceResultType.Error, "Invalid Token", null);
            }
        
            var token = tokenInfo.Split(" ")[1];
            tokenValidated = JwtUtils.ValidateToken(token);
            if (!tokenValidated)
            {
                return new ServiceResult<UserAccount>(ServiceResultType.Error, "Invalid Token", null);
            }
     
            //Get user info from token
            userAccount = sessionUtils.getUserAccountFromToken(tokenInfo);
        
            if (userAccount == null)
            {
                return new ServiceResult<UserAccount>(ServiceResultType.Error, "User not found", null);
            }

            /*
            //Check permission
            string actionName = context.ActionDescriptor.DisplayName.Split(" ")[0];
            var actionInfo = dbContext.UserActions.Where(x => x.Code.ToLower() == actionName.ToLower()).FirstOrDefault();
            var permissionCheckResult= authOperations.HasPermission(userAccount, actionInfo.Code);

            if(!permissionCheckResult.IsSuccess){
                return new ServiceResult<UserAccount>(ServiceResultType.Error, "Action Not Allowed For Registered User", userAccount);
            }
            */

            return new ServiceResult<UserAccount>(ServiceResultType.Success, "Action Allowed For Registered User", userAccount);
        
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
