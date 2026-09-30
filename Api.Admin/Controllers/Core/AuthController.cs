using System;
using System.Threading;
using System.Threading.Tasks;
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
        private readonly AuthOperations authOperations;

        public AuthController(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
            authOperations = new AuthOperations(context);
        }

        /// <summary>
        /// Provides login while flowing request cancellation through the database authentication path.
        /// </summary>
        [HttpPost]
        [Route("[controller]/Login")]
        public async Task<IActionResult> Login(
            [FromForm] UserAccountLoginViewModel viewModel,
            CancellationToken cancellationToken)
        {
            try
            {
                var authResult = await authOperations
                    .LoginUserAsync(viewModel, cancellationToken)
                    .ConfigureAwait(false);
                return new JsonResult(authResult);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }

        /// <summary>Provides logout facility for the user.</summary>
        [HttpPost]
        [ServiceFilter(typeof(AdminRequestFilterAttribute))]
        [Route("[controller]/Logout")]
        public IActionResult Logout()
        {
            try
            {
                var sessionResult = GetSession(HttpContext);
                if (!sessionResult.IsSuccess)
                {
                    return new JsonResult(sessionResult);
                }

                return new JsonResult("Çıkış yapıldı");
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return new JsonResult(exceptionResult(ex));
            }
        }
    }
}
