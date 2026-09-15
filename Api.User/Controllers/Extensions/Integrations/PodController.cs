using System;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Integrations.Operations;
using Microsoft.AspNetCore.Mvc;

namespace Api.User.Extensions.Controllers
{
    public class PodController : _BaseUserApiController
    {
        private PodOperations podOperations;

        public PodController(BusinessContext context)
        {
            this.dbContext = context;
            podOperations = new PodOperations(context);
        }

        /// <summary>
        /// Gets the list for tkgm districts with the given city id
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/List")]
        public async Task<IActionResult> List()
        {
            try
            {
                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = await podOperations.GetTodaysPods();
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
