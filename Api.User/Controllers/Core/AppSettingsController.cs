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
        private const string PublicMapConfigKey = "GisMapConfig";
        private readonly AppConfigOperations operations;

        public AppSettingsController(BusinessContext context)
        {
            dbContext = context;
            operations = new AppConfigOperations(context);
        }

        /// <summary>
        /// Returns the only application setting explicitly approved for anonymous map bootstrap.
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("[controller]/List")]
        public IActionResult List(string key)
        {
            try
            {
                if (!string.Equals(key?.Trim(), PublicMapConfigKey, StringComparison.Ordinal))
                {
                    return NotFound();
                }

                return new JsonResult(operations.GetConfig(PublicMapConfigKey));
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return StatusCode(500, new { message = "Configuration could not be loaded." });
            }
        }
    }
}
