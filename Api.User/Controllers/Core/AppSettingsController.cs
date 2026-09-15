using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;
using System;

namespace Api.User.Core.Controllers
{
    public class AppSettingsController : _BaseUserApiController
    {
        private AppConfigOperations ops;

        public AppSettingsController(BusinessContext context)
        {
            this.dbContext = context;
            ops = new AppConfigOperations(context);
        }


        /// <summary>
        /// Returns Application Settings with Key 
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/List")]
        public IActionResult List(string key)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                //TODO: check keys (tüm setting ler user apiye dönmemelidir)
                var result = ops.GetConfig(key);
                return new JsonResult(result);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
    }
}
