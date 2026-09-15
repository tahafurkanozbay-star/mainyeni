using Business.Core.Context;
using Business.Core.Model;
using System;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;
using Toolbox.Security.Jwt;
using Toolbox.Security.Url;

namespace Api.Core.Base
{
    public class SessionUtils
    {
        private readonly BusinessContext dbContext;

        public SessionUtils(BusinessContext context)
        {
            dbContext = context ?? throw new ArgumentNullException(nameof(context));
        }

        public UserAccount getUserAccountFromToken(string authorizationHeader)
        {
            if (!JwtUtils.TryGetBearerToken(authorizationHeader, out var token))
            {
                return null;
            }

            var principal = JwtUtils.GetPrincipal(token);
            if (principal == null)
            {
                return null;
            }

            var encryptedGuid = principal.FindFirst(ClaimTypes.Name)?.Value
                ?? principal.FindFirst(JwtRegisteredClaimNames.UniqueName)?.Value;

            if (string.IsNullOrWhiteSpace(encryptedGuid))
            {
                return null;
            }

            Guid guid;
            try
            {
                guid = ParameterEncryptionUtils.DecryptGuid(encryptedGuid);
            }
            catch (Exception ex) when (ex is FormatException || ex is ArgumentException || ex is InvalidOperationException)
            {
                return null;
            }

            var guidText = guid.ToString();
            return dbContext.UserAccounts.FirstOrDefault(x => !x.IsDeleted && x.IsActive && x.Guid == guidText);
        }

        // Kept for source compatibility with legacy callers. Do not use this method for authorization;
        // authorization must validate the token signature/lifetime through GetPrincipal first.
        public string getEgFromToken(JwtSecurityToken jwtToken)
        {
            if (jwtToken == null)
            {
                return null;
            }

            if (jwtToken.Payload.TryGetValue(JwtRegisteredClaimNames.UniqueName, out var value))
            {
                return value?.ToString();
            }

            return null;
        }
    }
}
