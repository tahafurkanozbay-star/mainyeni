using System;
using Api.Core.Base;
using Api.Admin.Filters;
using Business.Core.Context;
using Business.Core.Operations;
using Business.Core.ViewModel;
using Microsoft.AspNetCore.Mvc;

namespace Api.Admin.Core.Controllers
{
    public partial class AuthController : _BaseController
    {
        private UserAccountOperations userAccountOperations { get; set; }
        private AuthOperations authOperations { get; set; }


        public AuthController(BusinessContext context)
        {
            this.dbContext = context;
            this.userAccountOperations = new UserAccountOperations(context);
            this.authOperations = new AuthOperations(context);
        }


        /// <summary>
        /// Provide Login facility for the users 
        /// </summary>
        [HttpPost]
        [Route("[controller]/Login")]
        public IActionResult Login([FromForm] UserAccountLoginViewModel viewModel)
        {
            try
            {
                var authResult = authOperations.LoginUser(viewModel);
                return new JsonResult(authResult);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
    
        }


        /// <summary>
        /// Provides logout facility for the user 
        /// </summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Logout")]
        public IActionResult Logout()
        {
            try
            {
                var sessionResult = GetSession(HttpContext);

                if (sessionResult.IsSuccess)
                {
                    var session = sessionResult.Data;

                    //var result = ops.Create(viewModel, session);

                    return new JsonResult("Çıkış yapıldı");
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