using Api.Admin.Filters;
using Api.Core.Base;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace CityWorks.AdminApi.Gis
{
    [ApiController]
    public class BasemapLayerController : _BaseController
    {
        private readonly GisBasemapLayerOperations ops;

        public BasemapLayerController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            ops = new GisBasemapLayerOperations(context);
        }

        /// <summary>Returns active basemap layers using a no-tracking persistence read.</summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/List")]
        public async Task<IActionResult> List(CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);

                var result = await ops.GetAllAsync(cancellationToken).ConfigureAwait(false);
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

        /// <summary>Creates or updates a basemap layer while honoring request cancellation.</summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Save")]
        public async Task<IActionResult> Save(GisBasemapLayer viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);

                var result = viewModel != null && viewModel.Id > 0
                    ? await ops.UpdateAsync(viewModel, sessionResult.Data, cancellationToken).ConfigureAwait(false)
                    : await ops.CreateAsync(viewModel, sessionResult.Data, cancellationToken).ConfigureAwait(false);

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

        /// <summary>Soft-deletes a basemap layer while honoring request cancellation.</summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Delete")]
        public async Task<IActionResult> Delete(GisBasemapLayer viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);

                var id = viewModel?.Id ?? 0;
                var result = await ops.DeleteAsync(id, sessionResult.Data, cancellationToken).ConfigureAwait(false);
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
