using System;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Integrations.Operations;
using Microsoft.AspNetCore.Mvc;

namespace Api.User.Extensions.Controllers
{
    public class EgoController : _BaseUserApiController
    {
        private HatDurakBilgiOperations hatDurakOperations;

        public EgoController(BusinessContext context)
        {
            this.dbContext = context;
            hatDurakOperations = new HatDurakBilgiOperations(context);
        }

        /// <summary>
        /// gets the list of active lines
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/ActiveLines")]
        public async Task<IActionResult> ActiveLines()
        {
            try
            {

                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = await hatDurakOperations.ActiveLines();
                return new JsonResult(result);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        /// <summary>
        /// gets the list of active stops
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/ActiveStops")]
        public async Task<IActionResult> ActiveStops()
        {
            try
            {
                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = await hatDurakOperations.ActiveStops();
                return new JsonResult(result);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }


        /// <summary>
        /// gets the list of active lines
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/LineInfo/{lineNumber}")]
        public async Task<IActionResult> LineInfo(string lineNumber)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = await hatDurakOperations.LineInfo(lineNumber);
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
