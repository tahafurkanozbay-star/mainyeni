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
    public class EgoController : _BaseUserApiController
    {
        private readonly HatDurakBilgiOperations hatDurakOperations;

        public EgoController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            hatDurakOperations = new HatDurakBilgiOperations(context);
        }

        /// <summary>
        /// Gets the list of active lines.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/ActiveLines")]
        public async Task<IActionResult> ActiveLines(CancellationToken cancellationToken)
        {
            try
            {
                if (!ValidateAuthToken()) return UnAuthorizedResult();
                var result = await hatDurakOperations.ActiveLines(cancellationToken).ConfigureAwait(false);
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
        /// Gets the list of active stops.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/ActiveStops")]
        public async Task<IActionResult> ActiveStops(CancellationToken cancellationToken)
        {
            try
            {
                if (!ValidateAuthToken()) return UnAuthorizedResult();
                var result = await hatDurakOperations.ActiveStops(cancellationToken).ConfigureAwait(false);
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
        /// Gets information for one EGO line.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/LineInfo/{lineNumber}")]
        public async Task<IActionResult> LineInfo(string lineNumber, CancellationToken cancellationToken)
        {
            try
            {
                if (!ValidateAuthToken()) return UnAuthorizedResult();
                var result = await hatDurakOperations.LineInfo(lineNumber, cancellationToken).ConfigureAwait(false);
                return new JsonResult(result);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (ArgumentException ex)
            {
                return BadRequest(new { error = ex.Message });
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
    }
}
