using System.Data;
using System;
using System.Linq;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Toolbox.Generic;
using Toolbox.Security;
using Toolbox.Security.Cryptography;
using Toolbox.Security.Jwt;
using Toolbox.Security.Password;
using Toolbox.Security.Url;
using Toolbox.Text;
using System.Threading.Tasks;
using Toolbox.Date;

namespace Business.Core.Operations
{
    public class AuthOperations : _BaseOperations
    {
        private BusinessContext db;
        private AuthPasswordOperations authPasswordOperations;

        public AuthOperations(BusinessContext context)
        {
            this.db = context;
            this.authPasswordOperations=new AuthPasswordOperations(context);
        }

        ///User Login - Kullanıcı Girişi
        public ServiceResult<SessionInfo> LoginUser(UserAccountLoginViewModel viewModel)
        {
            var validationResult = validateLoginViewModel(viewModel);

            if (!validationResult.IsSuccess)
            {
                return new ServiceResult<SessionInfo>(ServiceResultType.Error,validationResult.Message,null);
            }

            bool isAuthenticated = false;

            var username = TextUtils.CleanString(viewModel.UserName.Trim().ToLower());

            int c = db.UserAccounts.Count();
            var list = db.UserAccounts
                        .Where(x =>x.UserName.ToLower().Trim() == username && !x.IsDeleted && x.IsActive)
                        .ToList();

            //LDAP Kontrolü
            string ldapUsername = username.Split('@')[0];
            string domainName = username.Split('@')[1];
            if (domainName == Configuration.LDAP_DOMAIN)
            {
                //LDAP User
                var ldapUtility =new LdapUtility(new LdapConfig(){
                        
                        UserDomainName = Configuration.LDAP_DOMAIN,
                        Path = "/"
                    });

                isAuthenticated = ldapUtility.Login(ldapUsername, viewModel.Password);

                if (isAuthenticated)
                {
                    if (list?.Count() == 0) //Eğer ldap kullanıcısı sistemde yoksa sisteme tanımlanır
                    {
                        //if user not exists in db create new record
                        var model = new Model.UserAccount();
                        model.UserName = TextUtils.CleanString(username);
                        model.FirstName = TextUtils.CleanString(TextUtils.Capitalize(username.Trim().ToLower()));
                        model.LastName = "";
                        model.IsSuperUser = false;
                        model.AccountType = UserAccountType.LDAP;
                        model.IsActive = true; //Kurum içi kullanıcılar otomatik olarak onaylanacaktır
                        model.Roles = ""; //Kurum içi kullanıcılar seçilen role atanacaktır
                        var salt = CryptoUtils.CreateRandomSalt();
                        model.Salt = salt;
                        model.Password = "-";
                        using (db)
                        {
                            model.SetCreate(-2);
                            db.UserAccounts.Add(model);
                            db.SaveChanges();
                        }
                    }

                    var userAccount =db.UserAccounts
                            .Where(x =>x.UserName.ToLower().Trim() == username &&!x.IsDeleted)
                            .ToList()
                            .FirstOrDefault();

                    var sessionInfo = createSession(userAccount);
                    return new ServiceResult<SessionInfo>(ServiceResultType.Success,sessionInfo);
                }
            }


            //EXTERNAL USER
            //Eğer ldap kullanıcısı değilse
            if (list?.Count() > 0)
            {
                var userAccount = list.FirstOrDefault();

                var encryptedPassword = authPasswordOperations.EncryptPassword(viewModel.Password, userAccount.Salt);
                if (encryptedPassword == userAccount.Password)
                {
                    var sessionInfo = createSession(userAccount);
                    return new ServiceResult<SessionInfo>(ServiceResultType
                            .Success,
                        sessionInfo);
                }
                else
                {
                    return new ServiceResult<SessionInfo>(ServiceResultType.Error,"Wrong username or password",null);
                }
            }
            else
            {
                return new ServiceResult<SessionInfo>(ServiceResultType.Error,
                    "Wrong username or password",
                    null);
            }
        }


        ///User Logout - Kullanıcı sistemden çıkış
        public ServiceResult LogoutUser(UserSessionViewModel session)
        {
            //TODO: Invalidate token
            //TODO: Log logout process
            return new ServiceResult(ServiceResultType.Success);
        }


        
        public ServiceResult ChangePasswordFromProfile( UserAccountChangePasswordViewModel viewModel, ClientRequestInfo info, UserSessionViewModel session)
        {
            var userAccount = db.UserAccounts.Where(x => x.Id == session.UserId).ToList().FirstOrDefault();

            if (userAccount == null)
            {
                return new ServiceResult(ServiceResultType.Error, "");
            }

             var encryptedPassword = authPasswordOperations.EncryptPassword(viewModel.OldPassword, userAccount.Salt);
                if (encryptedPassword != userAccount.Password)
                {
                    return new ServiceResult(ServiceResultType.Error,"Wrong username or password");
                }
        
            //Şifreyi değiştir
            var salt = CryptoUtils.CreateRandomSalt();
            userAccount.Password = authPasswordOperations.EncryptPassword(viewModel.NewPassword, salt);
            userAccount.Salt = salt;

            db.Entry(userAccount).State = Microsoft.EntityFrameworkCore.EntityState.Modified;

            db.SaveChanges();
            //Task.Run(() => { authMailOperations.SendPasswordChangeEmail(info, userAccount); });
            
            return new ServiceResult(ServiceResultType.Success, "");
        }


        private ServiceResult validateCreateViewModel(UserAccountCreateViewModel viewModel)
        {
            if (String.IsNullOrEmpty(viewModel.username))
            {
                return new ServiceResult(ServiceResultType.Error,
                    "Kullanıcı adı boş olamaz");
            }
            else
            {
                if (
                    viewModel
                        .username
                        .Trim()
                        .ToLower()
                        .Contains(Configuration.LDAP_DOMAIN)
                )
                {
                    return new ServiceResult(ServiceResultType.Error,
                        "Bu kullanıcı ile buradan kayıt olamazsınız, lütfen yöneticinize başvurun");
                }
            }

            if (!String.IsNullOrEmpty(viewModel.password))
            {
                var passwordValidationResult= authPasswordOperations.ValidatePassword(viewModel.password);

                if(!passwordValidationResult.IsSuccess){
                    return passwordValidationResult;
                }

                if (!String.IsNullOrEmpty(viewModel.passwordrepeat))
                {
                    if (viewModel.password != viewModel.passwordrepeat)
                    {
                        return new ServiceResult(ServiceResultType.Error,"Şifre ve tekrarı birbiriyle uyuşmuyor");
                    }
                }
                else
                {
                    return new ServiceResult(ServiceResultType.Error,"Şifre tekrarı boş olamaz");
                }
            }
            else
            {
                return new ServiceResult(ServiceResultType.Error, "Şifre boş olamaz");
            }

            return new ServiceResult(ServiceResultType.Success);
        }


        private ServiceResult validateLoginViewModel(UserAccountLoginViewModel viewModel)
        {
            if (String.IsNullOrEmpty(viewModel.UserName))
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı adı boş olamaz");
            }

            var passwordValidationResult= authPasswordOperations.ValidatePassword(viewModel.Password);

            if(!passwordValidationResult.IsSuccess){
                return passwordValidationResult;
            }

            return new ServiceResult(ServiceResultType.Success);
        }



        private SessionInfo createSession(UserAccount userAccount)
        {
            //TODO: Halihazırda son 1 saatte açık session varsa o bilgileri döndür
            var encryptedGuid =ParameterEncryptionUtils.EncryptGuid(Guid.Parse(userAccount.Guid));

            //Yoksa yeni session oluştur
            var sessionInfo =
                new SessionInfo()
                {
                    AccessToken = JwtUtils.GenerateToken(encryptedGuid),
                    RefreshToken = JwtUtils.GenerateToken(encryptedGuid),
                    FirstName = userAccount.FirstName,
                    LastName = userAccount.LastName,
                    SessionId = Guid.NewGuid().ToString(),
                    SessionStart = DateTime.Now.ToString(),
                    UserName = userAccount.UserName,
                    AccountType = userAccount.AccountType,
                    Roles = userAccount.Roles
                };
            
            return sessionInfo;
        }
    }
}