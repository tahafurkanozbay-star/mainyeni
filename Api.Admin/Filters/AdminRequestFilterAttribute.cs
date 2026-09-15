using Api.Core.Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using System;

namespace Api.Admin.Filters
{
    /// <summary>
    /// Validates the signed bearer token and resolves the active account before an admin action runs.
    /// Fine-grained action/role authorization remains a separate policy layer and must not be inferred here.
    /// </summary>
    public class AdminRequestFilterAttribute : IActionFilter
    {
        public const string UserAccountItemKey = "KentRehberi.UserAccount";

        private readonly SessionUtils sessionUtils;

        public AdminRequestFilterAttribute(BusinessContext dbContext)
        {
            sessionUtils = new SessionUtils(dbContext ?? throw new ArgumentNullException(nameof(dbContext)));
        }

        public void OnActionExecuted(ActionExecutedContext context)
        {
        }

        public void OnActionExecuting(ActionExecutingContext context)
        {
            var result = ValidateRequest(context);
            if (!result.IsSuccess)
            {
                context.Result = new ObjectResult(new { message = "Unauthorized" })
                {
                    StatusCode = StatusCodes.Status401Unauthorized
                };
                return;
            }

            context.HttpContext.Items[UserAccountItemKey] = result.Data;
        }

        private ServiceResult<UserAccount> ValidateRequest(ActionExecutingContext context)
        {
            var authorization = context.HttpContext.Request.Headers.Authorization.ToString();
            var userAccount = sessionUtils.getUserAccountFromToken(authorization);

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
