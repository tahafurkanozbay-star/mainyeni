using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading.Tasks;

namespace Api.User.Extensions.Controllers
{
    public class ConfigServiceController : _BaseUserApiController
    {
        private readonly GisConfigServiceOperations operations;

        public ConfigServiceController(BusinessContext context)
        {
            dbContext = context;
            operations = new GisConfigServiceOperations(context);
        }

        /// <summary>
        /// Returns public GIS service descriptors without upstream URLs or service credentials.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/ConfigService/List")]
        public async Task<IActionResult> List()
        {
            try
            {
                return new JsonResult(await operations.GetAllForPublicAsync(HttpContext.RequestAborted));
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return StatusCode(500, new { message = "GIS service configuration could not be loaded." });
            }
        }
    }
}
