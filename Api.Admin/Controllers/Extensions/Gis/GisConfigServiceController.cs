using System;
using System.Threading;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.Admin.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;

namespace CityWorks.AdminApi.Gis
{
    public class GisConfigServiceController : _BaseController
    {
        private readonly GisConfigServiceOperations gisConfigOperations;

        public GisConfigServiceController(BusinessContext context)
        {
            dbContext = context;
            gisConfigOperations = new GisConfigServiceOperations(context);
        }

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Delete")]
        public async Task<IActionResult> Delete(GisConfigService viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                var result = await gisConfigOperations.DeleteAsync(viewModel, sessionResult.Data, cancellationToken);
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

        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/List")]
        public async Task<IActionResult> List(CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                var result = await gisConfigOperations.GetAllGroupedAsync(cancellationToken);
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

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Save")]
        public async Task<IActionResult> Save([FromBody] GisConfigService viewModel, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);

                ServiceResult result = viewModel != null && viewModel.Id > 0
                    ? await gisConfigOperations.UpdateAsync(viewModel, sessionResult.Data, cancellationToken)
                    : await gisConfigOperations.CreateAsync(viewModel, sessionResult.Data, cancellationToken);
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

        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Import")]
        public async Task<IActionResult> Import(CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                if (!Request.HasFormContentType || Request.Form.Files.Count != 1)
                    return new JsonResult(new ServiceResult(ServiceResultType.Error, "Tek bir konfigürasyon dosyası gerekiyor"));

                var uploadedFile = Request.Form.Files[0];
                await using var fileStream = uploadedFile.OpenReadStream();
                var result = await gisConfigOperations.ImportAsync(uploadedFile.FileName, fileStream, sessionResult.Data, cancellationToken);
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

        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Export")]
        public async Task<IActionResult> Export(string format, CancellationToken cancellationToken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess) return new JsonResult(sessionResult);
                var result = await gisConfigOperations.GetAllAsync(cancellationToken);
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
