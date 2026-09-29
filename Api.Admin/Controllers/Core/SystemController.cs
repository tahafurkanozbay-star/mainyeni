using System;
using System.Threading;
using System.Threading.Tasks;
using Api.Core.Base;
using Business.Core.Context;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;

namespace CityWorks.AdminApi.SystemService
{
    public class SystemController : _BaseController
    {
        private readonly SystemOperations systemOperations;

        public SystemController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            systemOperations = new SystemOperations(context);
        }

        /// <summary>
        /// Returns status of the system components (db etc.).
        /// </summary>
        [HttpGet]
        [Route("[controller]/Check")]
        public async Task<IActionResult> Check(string key, CancellationToken cancellationToken)
        {
            try
            {
                var canConnect = await systemOperations.IsDatabaseConnectionExistsAsync(cancellationToken);
                var resultText = "Veritabanı bağlantısı: [" + (canConnect ? "Evet" : "Hayır") + "]";
                return new JsonResult(resultText);
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
