using System;
using System.IO;
using Api.Core.Base;
using Api.Admin.Filters;
using Business.Core.Common;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;

namespace CityWorks.AdminApi.Gis
{
    public class GisConfigServiceController : _BaseController
    {
        private GisConfigServiceOperations GisConfigOperations;

        public GisConfigServiceController(BusinessContext context)
        {
            this.dbContext = context;
            GisConfigOperations = new GisConfigServiceOperations(context);
        }

        /// <summary>
        /// Deletes a configuration service
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Delete")]
        public IActionResult Delete(GisConfigService viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = GisConfigOperations.Delete(viewModel, session);
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
        /// Gets the list for configuration services
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/List")]
        public IActionResult List()
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = GisConfigOperations.GetAllGrouped();
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
        /// Creates or update a configuration service
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Save")]
        public IActionResult Save([FromBody] GisConfigService viewModel)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    ServiceResult result = null;
                    if (viewModel.Id > 0)
                    {
                        result = GisConfigOperations.Update(viewModel, session);
                    }
                    else
                    {
                        result = GisConfigOperations.Create(viewModel, session);
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
        /// Creates or update a configuration service
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Import")]
        public IActionResult Import()
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                     var uploadedFile = Request.Form.Files[0];
                     var fileName = uploadedFile.FileName;
                     var fileStream=uploadedFile.OpenReadStream();
                    
                    ServiceResult result = GisConfigOperations.Import(fileName, fileStream, session);
                  
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
        /// Gets the list for configuration services
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("Gis/ConfigService/Export")]
        public IActionResult Export(string format)
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    var result = GisConfigOperations.GetAll();
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
