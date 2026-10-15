using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using System;
using System.Threading.Tasks;

namespace Api.Admin.Filters
{
    /// <summary>
    /// Validates the signed bearer token and resolves the active account before an admin action runs.
    /// Fine-grained action/role authorization remains a separate policy layer and must not be inferred here.
    /// </summary>
    public class AdminRequestFilterAttribute : IAsyncActionFilter
    {
        public const string UserAccountItemKey = "KentRehberi.UserAccount";

        private readonly SessionUtils sessionUtils;

        public AdminRequestFilterAttribute(BusinessContext dbContext)
        {
            sessionUtils = new SessionUtils(dbContext ?? throw new ArgumentNullException(nameof(dbContext)));
        }

        public async Task OnActionExecutionAsync(
            ActionExecutingContext context,
            ActionExecutionDelegate next)
        {
            var result = await ValidateRequestAsync(context).ConfigureAwait(false);
            if (!result.IsSuccess)
            {
                context.Result = new ObjectResult(new { message = "Unauthorized" })
                {
                    StatusCode = StatusCodes.Status401Unauthorized
                };
                return;
            }

            context.HttpContext.Items[UserAccountItemKey] = result.Data;
            await next().ConfigureAwait(false);
        }

        private async Task<ServiceResult<UserAccount>> ValidateRequestAsync(ActionExecutingContext context)
        {
            var authorization = context.HttpContext.Request.Headers.Authorization.ToString();
            var userAccount = await sessionUtils.GetUserAccountFromTokenAsync(
                authorization, context.HttpContext.RequestAborted).ConfigureAwait(false);

            if (userAccount == null)
            {
                return new ServiceResult<UserAccount>(ServiceResultType.Error, "Invalid or expired token", null);
            }

            return new ServiceResult<UserAccount>(
                ServiceResultType.Success,
                "Action allowed for authenticated user",
                userAccount);
        }
    }
}
