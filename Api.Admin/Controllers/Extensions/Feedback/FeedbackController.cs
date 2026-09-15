using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using System;
using Microsoft.AspNetCore.Mvc;
using Api.Admin.Filters;
using Business._Base;
using Business.Extensions.Gis.Model;
using Business.Extensions.FeedbackService.Operations;
using Business.Extensions.FeedbackService.ViewModel;

namespace CityWorks.AdminApi.Feedback
{

    [ApiController]
    public class FeedbackController : _BaseController
    {
        private FeedbackOperations ops;
        public FeedbackController(BusinessContext context)
        {
            this.dbContext = context;
            ops = new FeedbackOperations(context);
        }



                /// <summary>
        /// Search the BasemapLayers
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/List")]
        public IActionResult List([FromQuery] _BaseSearchViewModel viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = ops.List(viewModel,session);

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
        /// Search the Feedbacks
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Save")]
        public IActionResult Update([FromQuery] int id, [FromQuery]int status, [FromQuery]int actionTaken)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);

                if (!sessionResult.IsSuccess)
                {
                     return new JsonResult(sessionResult);
                }

                var userSession = sessionResult.Data;
                var result = ops.Update(id, status,actionTaken, userSession);
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
