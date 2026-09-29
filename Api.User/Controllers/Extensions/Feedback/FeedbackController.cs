using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.FeedbackService.Operations;
using Business.Extensions.FeedbackService.ViewModel;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;
using UAParser;

namespace Api.User.Extensions.Controllers
{
    [ApiController]
    public class FeedbackController : _BaseUserApiController
    {
        private readonly FeedbackOperations ops;

        public FeedbackController(BusinessContext context)
        {
            dbContext = context;
            ops = new FeedbackOperations(context);
        }

        /// <summary>
        /// Saves a feedback record while honoring request cancellation.
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/Save")]
        public async Task<IActionResult> Save([FromQuery] FeedbackViewModel viewModel, CancellationToken cancellationToken)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                    return UnAuthorizedResult();
                }

                cancellationToken.ThrowIfCancellationRequested();

                var request = HttpContext.Request;
                var ua = request.Headers.UserAgent.ToString();
                var clientInfo = Parser.GetDefault().Parse(ua);

                viewModel.Ip = HttpContext.Connection.RemoteIpAddress?.ToString();
                viewModel.Browser = clientInfo.UA.ToString();
                viewModel.Os = clientInfo.OS.ToString();
                viewModel.Device = clientInfo.Device.ToString();

                var result = await ops.CreateAsync(viewModel, cancellationToken).ConfigureAwait(false);
                return new JsonResult(result);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
    }
}
