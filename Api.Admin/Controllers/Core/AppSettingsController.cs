using Api.Admin.Filters;
using Api.Core.Base;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace CityWorks.AdminApi.Config
{
    public class AppSettingsController : _BaseController
    {
        private readonly AppConfigOperations ops;

        public AppSettingsController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            ops = new AppConfigOperations(context);
        }

        /// <summary>
        /// Returns application settings for a key without tracking read-only state.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/List")]
        public async Task<IActionResult> List(string key, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }

                var result = await ops.GetConfigAsync(key, cancellationToken).ConfigureAwait(false);
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
        /// Saves application configuration while honoring request cancellation.
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Save")]
        public async Task<IActionResult> Save(AppConfig viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }

                var result = await ops.UpdateAsync(viewModel, sessionResult.Data, cancellationToken).ConfigureAwait(false);
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
