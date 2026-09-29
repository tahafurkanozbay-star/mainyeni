using Api.Admin.Filters;
using Api.Core.Base;
using Business._Base;
using Business.Core.Context;
using Business.Extensions.FeedbackService.Operations;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace CityWorks.AdminApi.Feedback
{
    [ApiController]
    public class FeedbackController : _BaseController
    {
        private readonly FeedbackOperations ops;

        public FeedbackController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            ops = new FeedbackOperations(context);
        }

        /// <summary>
        /// Lists feedback records using bounded, cancellation-aware persistence access.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/List")]
        public async Task<IActionResult> List([FromQuery] _BaseSearchViewModel viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);

                var result = await ops.ListAsync(viewModel, sessionResult.Data, cancellationToken).ConfigureAwait(false);
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

        /// <summary>
        /// Updates feedback workflow state while honoring request cancellation.
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Save")]
        public async Task<IActionResult> Update([FromQuery] int id, [FromQuery] int status, [FromQuery] int actionTaken, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);

                var result = await ops.UpdateAsync(id, status, actionTaken, sessionResult.Data, cancellationToken).ConfigureAwait(false);
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
