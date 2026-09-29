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
    public class LayerGroupController : _BaseController
    {
        private readonly GisLayerGroupOperations ops;

        public LayerGroupController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            ops = new GisLayerGroupOperations(context);
        }

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Save")]
        public async Task<IActionResult> Save(GisLayerGroup viewModel, CancellationToken cancellationToken)
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
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Delete")]
        public async Task<IActionResult> Delete(GisLayerGroup viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                var result = await ops.DeleteAsync(viewModel, sessionResult.Data, cancellationToken).ConfigureAwait(false);
                return new JsonResult(result);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/List")]
        public async Task<IActionResult> List(CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                return new JsonResult(await ops.GetAllAsync(cancellationToken).ConfigureAwait(false));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/ListWithLayers")]
        public async Task<IActionResult> ListWithLayers(CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                return new JsonResult(await ops.GetAllWithLayersForAdminAsync(cancellationToken).ConfigureAwait(false));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
    }
}
