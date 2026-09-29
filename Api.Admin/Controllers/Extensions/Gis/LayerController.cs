using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Business.Extensions.Gis.ViewModel;
using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Api.Admin.Filters;
using Business._Base;

namespace CityWorks.AdminApi.Gis
{
    [ApiController]
    public class LayerController : _BaseController
    {
        private readonly GisLayerOperations ops;

        public LayerController(BusinessContext context)
        {
            dbContext = context;
            ops = new GisLayerOperations(context);
        }

        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/List")]
        public async Task<IActionResult> List([FromQuery] _BaseSearchViewModel viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }

                var result = await ops.GetAllAsync(HttpContext.RequestAborted);
                return new JsonResult(result);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Save")]
        public async Task<IActionResult> Save([FromBody] GisLayerAdminViewModel viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }

                var session = sessionResult.Data;
                ServiceResult result = viewModel != null && viewModel.Id > 0
                    ? await ops.UpdateAsync(viewModel, session, HttpContext.RequestAborted)
                    : await ops.CreateAsync(viewModel, session, HttpContext.RequestAborted);
                return new JsonResult(result);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Delete")]
        public async Task<IActionResult> Delete([FromBody] GisLayerAdminViewModel viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }

                if (viewModel == null)
                {
                    return new JsonResult(new ServiceResult(ServiceResultType.Error, "Katman bilgisi boş olamaz"));
                }

                var result = await ops.DeleteAsync(
                    viewModel.Id,
                    sessionResult.Data,
                    HttpContext.RequestAborted);
                return new JsonResult(result);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
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
