using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Business.Core.ViewModel;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;
using System;
using System.Linq;
using UAParser;
using Microsoft.AspNetCore.HttpOverrides;

namespace Api.User.Core.Controllers
{
    public class ClientLogController : _BaseUserApiController
    {
        private ClientLogOperations ops;

        public ClientLogController(BusinessContext context)
        {
            this.dbContext = context;
            ops = new ClientLogOperations(context);
        }


        [HttpPost]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        //[Route("[controller]/Create")]
        [Route("cl/c")]
        public IActionResult Create([FromForm] ClientLogUserCreateViewModel viewModel)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                    return UnAuthorizedResult();
                }


                var ops = new ClientLogOperations(dbContext);

                var uaParser = Parser.GetDefault();

                var request = HttpContext.Request;

                //var ip = request.HttpContext.Connection.RemoteIpAddress;
                StringValues ipVals = StringValues.Empty;
                request.Headers.TryGetValue("X-Forwarded-For", out ipVals);

                string ip = HttpContext.Connection.RemoteIpAddress.ToString();
            
                var iplocal = request.HttpContext.Connection.LocalIpAddress?.ToString();

                string ua = request.Headers["User-Agent"].ToString();
                var clientInfo = uaParser.Parse(ua);

                var os = clientInfo.OS.ToString();
                var device = clientInfo.Device.ToString();
                var browser = clientInfo.UA.ToString();

                var result= ops.Create(viewModel.logType,browser,os ,device,ip,viewModel.description);

                return new JsonResult(result);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
    }
}
