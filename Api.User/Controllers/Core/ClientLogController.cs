using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Core.Operations;
using Business.Core.ViewModel;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;
using UAParser;

namespace Api.User.Core.Controllers
{
    public class ClientLogController : _BaseUserApiController
    {
        private readonly ClientLogOperations ops;

        public ClientLogController(BusinessContext context)
        {
            dbContext = context;
            ops = new ClientLogOperations(context);
        }

        [HttpPost]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("cl/c")]
        public async Task<IActionResult> Create(
            [FromForm] ClientLogUserCreateViewModel viewModel,
            CancellationToken cancellationToken)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                    return UnAuthorizedResult();
                }

                if (viewModel == null)
                {
                    return BadRequest();
                }

                var request = HttpContext.Request;
                var ip = HttpContext.Connection.RemoteIpAddress?.ToString() ?? string.Empty;
                var userAgent = request.Headers.UserAgent.ToString();
                var clientInfo = Parser.GetDefault().Parse(userAgent);

                var result = await ops.CreateAsync(
                    viewModel.logType,
                    clientInfo.UA.ToString(),
                    clientInfo.OS.ToString(),
                    clientInfo.Device.ToString(),
                    ip,
                    viewModel.description,
                    cancellationToken).ConfigureAwait(false);

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
