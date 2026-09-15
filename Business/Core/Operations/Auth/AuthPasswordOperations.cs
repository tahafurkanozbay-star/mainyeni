using System;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Business._Base;
using Business.Core.Common;
using Business.Core.Model;
using Business.Core.Context;
using Business.Core.ViewModel;
using Microsoft.AspNetCore.Authentication;
using Toolbox.Generic;
using Toolbox.Security;
using Toolbox.Security.Jwt;
using Toolbox.Security.Password;
using Toolbox.Text;
using System.Text.RegularExpressions; 
using System.Threading.Tasks;

namespace Business.Core.Operations
{
    public class AuthPasswordOperations : _BaseOperations
    {
        private BusinessContext db;

        public AuthPasswordOperations(BusinessContext context)
        {
            this.db = context;
        }

        public ServiceResult ValidatePassword(string password){
            
            if (password.Length < Configuration.MIN_PASSWORD_LENGTH){
                return new ServiceResult(ServiceResultType.Error, "Şifre en az "+Configuration.MIN_PASSWORD_LENGTH+" karakter olmalıdır");
                }

            if (password.Length > Configuration.MAX_PASSWORD_LENGTH){
                return new ServiceResult(ServiceResultType.Error, "Şifre en fazla "+Configuration.MAX_PASSWORD_LENGTH+" karakter olmalıdır");
                }
            
            return new ServiceResult(ServiceResultType.Success,"");
        }


        public string EncryptPassword(string password, string salt)
        {
            var encryptedPassword =PasswordUtils.Encrypt(password, salt, new SHA1Encryptor());
            return encryptedPassword;
        }

    }
}