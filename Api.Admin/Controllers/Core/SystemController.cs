using System;
using Api.Core.Base;
using Business.Core.Context;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;

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
        [Route("[controller]/Check")]
        public IActionResult Check(string key)
        {
            try
            {
                string resultText = "";
                
                using (dbContext)
                {
                    string canConnect=dbContext.Database.CanConnect() ? "Evet" : "Hayır";
                    resultText += "Veritabanı bağlantısı: ["+canConnect+"]";
                }
                
                return new JsonResult(resultText);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

    
    }
}
