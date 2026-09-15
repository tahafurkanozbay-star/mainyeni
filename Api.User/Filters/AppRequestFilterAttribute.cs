using Business.Core.Common;
using Business.Core.Model;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Api.User.Filters
{
    /// <summary>
    /// Marker filter for endpoints intentionally available to anonymous map users.
    /// Authentication must be explicit on any future privileged user endpoint rather than
    /// relying on a client-generated shared secret.
    /// </summary>
    public class AppRequestFilterAttribute : IActionFilter
    {
        public void OnActionExecuted(ActionExecutedContext context)
        {
        }

        public void OnActionExecuting(ActionExecutingContext context)
        {
            // Public endpoints are deliberately anonymous. Their response models must remain
            // data-minimized and server-owned; do not add client-visible secrets here.
        }

        protected ServiceResult<UserAccount> validateRequest(ActionExecutingContext context)
        {
            return new ServiceResult<UserAccount>(
                ServiceResultType.Success,
                "Action allowed for anonymous user",
                null);
        }
    }
}
