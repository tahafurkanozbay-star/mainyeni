using System;
using System.IO;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;

namespace Api.User.Extensions.Controllers
{
    public class ConfigServiceController : _BaseUserApiController
    {
        private GisConfigServiceOperations GisConfigOperations;

        public ConfigServiceController(BusinessContext context)
        {
            this.dbContext = context;
            GisConfigOperations = new GisConfigServiceOperations(context);
        }


        /// <summary>
        /// Gets the list for configuration services
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/ConfigService/List")]
        public IActionResult List()
        {
            try
            {

                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = GisConfigOperations.GetAllForPublic();
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
