using System;
using Microsoft.AspNetCore.Http;
using Business.Core.Context;
using System.Collections.Generic;
using System.IdentityModel.Tokens.Jwt;
using Business.Core.Model;
using Toolbox.Security.Jwt;
using Business.Core.Operations;
using System.Linq;
using Toolbox.Security.Url;

namespace Api.Core.Base
{

    public class SessionUtils
    {

        private BusinessContext dbContext { get; set; }
     
        public SessionUtils(BusinessContext _context)
        {
            this.dbContext = _context;
        }

        public UserAccount getUserAccountFromToken(string tokenInfo)
        {
            if (!String.IsNullOrEmpty(tokenInfo))
            {
                var token = tokenInfo.Split(" ")[1];
                List<string> queryStringParams = new List<string>();
                var jwtToken = JwtUtils.ReadToken(token);

                string eg = getEgFromToken(jwtToken); ;

                UserAccount account;
                using (dbContext)
                {
                    
                    Guid guid = ParameterEncryptionUtils.DecryptGuid(eg);

                    account = dbContext.UserAccounts.Where(x => !x.IsDeleted && x.Guid == guid.ToString()).FirstOrDefault();
                    return account;
                }


                
            }
            return null;
        }


        public string getEgFromToken(JwtSecurityToken jwtToken)
        {
            object eg_value = null;
            jwtToken.Payload.TryGetValue("unique_name", out eg_value);
            if (eg_value != null)
            {
                string eg = eg_value.ToString();
                return eg;
            }
            else
            {
                return null;
            }

        }

    }

}