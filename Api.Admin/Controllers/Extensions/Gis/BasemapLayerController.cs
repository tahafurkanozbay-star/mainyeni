using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using System;
using Microsoft.AspNetCore.Mvc;
using Api.Admin.Filters;
using Business._Base;
using Business.Extensions.Gis.Model;

namespace CityWorks.AdminApi.Gis
{

    [ApiController]
    public class BasemapLayerController : _BaseController
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
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/List")]
        public IActionResult List([FromQuery] _BaseSearchViewModel viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = ops.GetAll();

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
        /// Creates/updates BasemapLayer
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Save")]
        
        public IActionResult Save(GisBasemapLayer viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);

                if (!sessionResult.IsSuccess)
                {
                     return new JsonResult(sessionResult);
                }

                var session = sessionResult.Data;
                
                ServiceResult result = null;
                
                if (viewModel.Id>0)
                {
                    result = ops.Update(viewModel,session);
                }
                else
                {
                    result = ops.Create(viewModel,session);
                }

                return new JsonResult(result);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
        
        /// <summary>
        /// Deletes BasemapLayer
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Delete")]
        public IActionResult Delete(GisBasemapLayer viewModel)
        {
             try
            {
                var sessionResult = GetSession(HttpContext);

                if (!sessionResult.IsSuccess)
                {
                     return new JsonResult(sessionResult);
                }

                var session = sessionResult.Data;
                
                ServiceResult result = ops.Delete(viewModel.Id, session);
                
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
