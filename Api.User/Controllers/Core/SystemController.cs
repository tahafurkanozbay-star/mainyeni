using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;
using System;
using UAParser;

namespace Api.User.Controllers
{
    public class SystemController: _BaseController
    {
        /// <summary>
        /// Health Check
        /// </summary>
        [HttpGet]
        [Route("[controller]/HealthCheck")]
        public IActionResult HealthCheck()
        {
            return Ok("OK");
        }
    }

}
