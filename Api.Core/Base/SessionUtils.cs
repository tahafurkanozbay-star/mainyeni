using Business.Core.Context;
using Business.Core.Model;
using System;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
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
            var guidText = ValidatedAccountGuid(authorizationHeader);
            return guidText == null
                ? null
                : dbContext.UserAccounts.FirstOrDefault(x => !x.IsDeleted && x.IsActive && x.Guid == guidText);
        }

        /// <summary>
        /// Nonblocking account lookup for the HTTP authorization pipeline.
        /// The token signature and lifetime are verified before querying.
        /// </summary>
        public async Task<UserAccount> GetUserAccountFromTokenAsync(
            string authorizationHeader,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var guidText = ValidatedAccountGuid(authorizationHeader);
            if (guidText == null) return null;

            return await dbContext.UserAccounts.FirstOrDefaultAsync(
                x => !x.IsDeleted && x.IsActive && x.Guid == guidText,
                cancellationToken).ConfigureAwait(false);
        }

        private static string ValidatedAccountGuid(string authorizationHeader)
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

            return guid.ToString();
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
