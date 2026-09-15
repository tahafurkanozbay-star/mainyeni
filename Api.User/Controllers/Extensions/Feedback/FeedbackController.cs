using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using System;
using Microsoft.AspNetCore.Mvc;
using Api.User.Filters;
using Business._Base;
using Business.Extensions.Gis.Model;
using Business.Extensions.FeedbackService.Operations;
using Business.Extensions.FeedbackService.ViewModel;
using UAParser;

namespace Api.User.Extensions.Controllers
{

    [ApiController]
    public class FeedbackController : _BaseUserApiController
    {
        private FeedbackOperations ops;
        public FeedbackController(BusinessContext context)
        {
            this.dbContext = context;
            ops = new FeedbackOperations(context);
        }


        /// <summary>
        /// Search the Feedbacks
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/Save")]
        public IActionResult Save([FromQuery] FeedbackViewModel viewModel)
        {
            try
            {

                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }


                var uaParser = Parser.GetDefault();

                var request = HttpContext.Request;
                string ua = request.Headers["User-Agent"].ToString();
                var clientInfo = uaParser.Parse(ua);

                var os = clientInfo.OS.ToString();
                var device = clientInfo.Device.ToString();
                var browser = clientInfo.UA.ToString();

                string ip = HttpContext.Connection.RemoteIpAddress.ToString();
                viewModel.Ip = ip;
                viewModel.Browser = browser;
                viewModel.Os = os;
                viewModel.Device = device;

                var result = ops.Create(viewModel);
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
