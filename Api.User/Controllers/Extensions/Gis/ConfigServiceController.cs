using System;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;

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

        /// <summary>Returns sanitized GIS service descriptors intended for public map bootstrap.</summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/ConfigService/List")]
        public IActionResult List()
        {
            try
            {
                return new JsonResult(operations.GetAllForPublic());
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return StatusCode(500, new { message = "GIS service configuration could not be loaded." });
            }
        }
    }
}
