using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;
using System;

namespace Api.User.Extensions.Controllers
{
    // NOTE: You can use the "Rename" command on the "Refactor" menu to change the class name "LayerGroups" in code, svc and config file together.
    // NOTE: In order to launch WCF Test Client for testing this service, please select LayerGroups.svc or LayerGroups.svc.cs at the Solution Explorer and start debugging.
    public class LayerController : _BaseUserApiController
    {
        private GisLayerGroupOperations ops;

        public LayerController(BusinessContext context)
        {
            ops = new GisLayerGroupOperations(context);
            this.dbContext = context;
        }

        /// <summary>
        /// Search the layers
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/ListGrouped")]
        public IActionResult ListGrouped()
        {
            try
            {

                if (!ValidateAuthToken())
                {
                  return UnAuthorizedResult();
                }

                var result = ops.GetAllWithLayersForUser();
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
