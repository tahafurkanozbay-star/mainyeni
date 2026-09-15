using Api.Core.Base;
using Api.Admin.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Operations;
using Microsoft.AspNetCore.Mvc;
using System;

namespace CityWorks.AdminApi.Config
{
    public class AppSettingsController : _BaseController
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
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/List")]
        public IActionResult List(string key)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = ops.GetConfig(key);
                    return new JsonResult(result);
                }
                else
                {
                    return new JsonResult(sessionResult);
                }
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        /// <summary>
        /// Save Application config with Key 
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Save")]
        public IActionResult Save(AppConfig viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    ServiceResult<AppConfig> result = null;

                    result = ops.Update(viewModel, session);


                    return new JsonResult(result);
                }
                else
                {
                    return new JsonResult(sessionResult);
                }
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }

        }


    }
}
