using Api.Core.Base;
using Api.Admin.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;
using System;

namespace CityWorks.AdminApi.Gis
{
    // NOTE: You can use the "Rename" command on the "Refactor" menu to change the class name "LayerGroups" in code, svc and config file together.
    // NOTE: In order to launch WCF Test Client for testing this service, please select LayerGroups.svc or LayerGroups.svc.cs at the Solution Explorer and start debugging.
    public class LayerGroupController : _BaseController
    {
        private GisLayerGroupOperations ops;

        public LayerGroupController(BusinessContext context)
        {
            ops = new GisLayerGroupOperations(context);
            this.dbContext = context;
        }


        /// <summary>
        /// Creates/updates layer
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Save")]

        public IActionResult Save(GisLayerGroup viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);

                if (sessionResult.IsSuccess)
                {
                    ServiceResult result = null;

                    var session = sessionResult.Data;

                    if (viewModel.Id > 0)
                    {
                        result = ops.Update(viewModel, session);
                    }
                    else
                    {
                        result = ops.Create(viewModel, session);
                    }

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
        /// Deletes layer
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/Delete")]

        public IActionResult Delete(GisLayerGroup viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);

                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = ops.Delete(viewModel, session);
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
        /// Search the layers
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/List")]
        public IActionResult List()
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
        /// Search the layers
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/[controller]/ListWithLayers")]
        public IActionResult ListWithLayers()
        {

            try
            {
                var sessionResult = GetSession(HttpContext);

                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = ops.GetAllWithLayersForAdmin();
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
