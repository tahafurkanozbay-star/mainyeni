using System;
using System.Threading;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Integrations.Operations;
using Microsoft.AspNetCore.Mvc;

namespace Api.User.Extensions.Controllers
{
    public class PodController : _BaseUserApiController
    {
        private readonly PodOperations podOperations;

        public PodController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            podOperations = new PodOperations(context);
        }

        /// <summary>
        /// Gets the current duty-pharmacy list through the server-side provider boundary.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/List")]
        public async Task<IActionResult> List(CancellationToken cancellationToken)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                    return UnAuthorizedResult();
                }

                var result = await podOperations
                    .GetTodaysPods(cancellationToken)
                    .ConfigureAwait(false);
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
