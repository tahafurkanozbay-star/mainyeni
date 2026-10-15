using System;
using Api.Admin.Filters;
using Api.Core.Base;
using Business.Core.Context;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System.Threading;
using System.Threading.Tasks;

namespace CityWorks.AdminApi.SystemService
{
    // NOTE: You can use the "Rename" command on the "Refactor" menu to change the class name "Install" in code, svc and config file together.
    // NOTE: In order to launch WCF Test Client for testing this service, please select Install.svc or Install.svc.cs at the Solution Explorer and start debugging.
    public class SystemController : _BaseController
    {
        private SystemOperations systemOperations;
        private AppConfigOperations appConfigOperations;

        public SystemController(BusinessContext context)
        {
            this.dbContext=context;
            systemOperations=new SystemOperations(context);
            appConfigOperations=new AppConfigOperations(context);
        }

        /// <summary>
        /// Returns status of the system components (db etc.) 
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Check")]
        public async Task<IActionResult> Check(string key, CancellationToken cancellationToken)
        {
            try
            {
                string resultText = "";
                
                // The request's pooled DbContext belongs to DI and must never
                // be disposed by this action. The authorization filter runs first.
                bool canConnect = await dbContext.Database.CanConnectAsync(cancellationToken)
                    .ConfigureAwait(false);
                resultText += "Veritabanı bağlantısı: [" + (canConnect ? "Evet" : "Hayır") + "]";
                
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
