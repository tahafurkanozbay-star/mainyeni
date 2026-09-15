using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using System;
using Microsoft.AspNetCore.Mvc;
using Api.User.Filters;
using Business._Base;
using Business.Extensions.Gis.Model;

namespace Api.User.Extensions.Controllers
{

    [ApiController]
    public class BasemapLayerController : _BaseUserApiController
    {
        private GisBasemapLayerOperations ops;
        public BasemapLayerController(BusinessContext context)
        {
            this.dbContext = context;
            ops = new GisBasemapLayerOperations(context);
        }


        /// <summary>
        /// Search the BasemapLayers
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/List")]
        public IActionResult List([FromQuery] _BaseSearchViewModel viewModel)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = ops.GetAll();
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
