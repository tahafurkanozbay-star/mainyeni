using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using Toolbox.Generic;
using Toolbox.Security.Jwt;
using Toolbox.Security.Url;
using Toolbox.Text;

namespace Business.Core.Operations
{
    public class AuthOperations : _BaseOperations
    {
        private readonly BusinessContext db;
        private readonly AuthPasswordOperations authPasswordOperations;

        public AuthOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
            authPasswordOperations = new AuthPasswordOperations(context);
        }

        /// <summary>User Login - Kullanıcı Girişi</summary>
        public ServiceResult<SessionInfo> LoginUser(UserAccountLoginViewModel viewModel)
        {
            var validationResult = validateLoginViewModel(viewModel);
            if (!validationResult.IsSuccess)
            {
                return new ServiceResult<SessionInfo>(ServiceResultType.Error, validationResult.Message, null);
            }

            var username = TextUtils.CleanString(viewModel.UserName.Trim().ToLowerInvariant());
            var accounts = db.UserAccounts
                .Where(x => x.UserName.ToLower().Trim() == username && !x.IsDeleted && x.IsActive)
                .ToList();

            var atIndex = username.LastIndexOf('@');
            var ldapUsername = atIndex > 0 ? username.Substring(0, atIndex) : username;
            var domainName = atIndex > 0 && atIndex < username.Length - 1
                ? username.Substring(atIndex + 1)
                : string.Empty;

            var ldapDomain = Configuration.LDAP_DOMAIN?.Trim();
            if (!string.IsNullOrWhiteSpace(ldapDomain) &&
                !string.IsNullOrWhiteSpace(Configuration.LDAP_SERVER) &&
                string.Equals(domainName, ldapDomain, StringComparison.OrdinalIgnoreCase))
            {
                var ldapUtility = new LdapUtility(new LdapConfig
                {
                    UserDomainName = ldapDomain,
                    Server = Configuration.LDAP_SERVER,
                    Port = Configuration.LDAP_PORT,
                    SecureSocketLayer = Configuration.LDAP_USE_SSL,
                    BindDomain = Configuration.LDAP_BIND_DOMAIN
                });

                if (ldapUtility.Login(ldapUsername, viewModel.Password))
                {
                    var userAccount = accounts.FirstOrDefault();
                    if (userAccount == null)
                    {
                        userAccount = new UserAccount
                        {
                            UserName = username,
                            FirstName = TextUtils.Capitalize(ldapUsername.Trim().ToLowerInvariant()),
                            LastName = string.Empty,
                            IsSuperUser = false,
                            AccountType = UserAccountType.LDAP,
                            IsActive = true,
                            Roles = string.Empty,
                            Salt = string.Empty,
                            Password = "-"
                        };
                        userAccount.SetCreate(-2);
                        db.UserAccounts.Add(userAccount);
                        db.SaveChanges();
                    }

                    return new ServiceResult<SessionInfo>(
                        ServiceResultType.Success,
                        createSession(userAccount));
                }
            }

            var externalAccount = accounts.FirstOrDefault(x => x.AccountType == UserAccountType.EXTERNAL);
            if (externalAccount == null)
            {
                return InvalidCredentials();
            }

            if (!authPasswordOperations.VerifyPassword(
                    viewModel.Password,
                    externalAccount.Password,
                    externalAccount.Salt,
                    out var needsRehash))
            {
                return InvalidCredentials();
            }

            if (needsRehash)
            {
                externalAccount.Password = authPasswordOperations.HashPassword(viewModel.Password);
                externalAccount.Salt = string.Empty;
                db.Entry(externalAccount).Property(x => x.Password).IsModified = true;
                db.Entry(externalAccount).Property(x => x.Salt).IsModified = true;
                db.SaveChanges();
            }

            return new ServiceResult<SessionInfo>(
                ServiceResultType.Success,
                createSession(externalAccount));
        }

        public ServiceResult LogoutUser(UserSessionViewModel session)
        {
            // Access tokens are short-lived and signed. Server-side revocation/session persistence
            // is intentionally tracked as a separate migration before refresh tokens are relied on.
            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult ChangePasswordFromProfile(
            UserAccountChangePasswordViewModel viewModel,
            ClientRequestInfo info,
            UserSessionViewModel session)
        {
            if (viewModel == null || session == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Geçersiz istek");
            }

            var newPasswordValidation = authPasswordOperations.ValidatePassword(viewModel.NewPassword);
            if (!newPasswordValidation.IsSuccess)
            {
                return newPasswordValidation;
            }

            if (!string.Equals(viewModel.NewPassword, viewModel.NewPasswordRepeat, StringComparison.Ordinal))
            {
                return new ServiceResult(ServiceResultType.Error, "Şifre ve tekrarı birbiriyle uyuşmuyor");
            }

            var userAccount = db.UserAccounts
                .FirstOrDefault(x => x.Id == session.UserId && !x.IsDeleted && x.IsActive);
            if (userAccount == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı bulunamadı");
            }

            if (!authPasswordOperations.VerifyPassword(
                    viewModel.OldPassword,
                    userAccount.Password,
                    userAccount.Salt,
                    out _))
            {
                return new ServiceResult(ServiceResultType.Error, "Wrong username or password");
            }

            userAccount.Password = authPasswordOperations.HashPassword(viewModel.NewPassword);
            userAccount.Salt = string.Empty;
            db.Entry(userAccount).State = EntityState.Modified;
            db.SaveChanges();

            return new ServiceResult(ServiceResultType.Success, "");
        }

        private ServiceResult validateLoginViewModel(UserAccountLoginViewModel viewModel)
        {
            if (viewModel == null || string.IsNullOrWhiteSpace(viewModel.UserName))
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı adı boş olamaz");
            }

            // Login accepts legacy password lengths so an existing account can authenticate once
            // and be transparently rehashed. New password writes use the stronger policy.
            if (string.IsNullOrEmpty(viewModel.Password) || viewModel.Password.Length > Configuration.MAX_PASSWORD_LENGTH)
            {
                return new ServiceResult(ServiceResultType.Error, "Wrong username or password");
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        private static ServiceResult<SessionInfo> InvalidCredentials()
        {
            return new ServiceResult<SessionInfo>(
                ServiceResultType.Error,
                "Wrong username or password",
                null);
        }

        private SessionInfo createSession(UserAccount userAccount)
        {
            if (userAccount == null || string.IsNullOrWhiteSpace(userAccount.Guid))
            {
                throw new InvalidOperationException("Cannot create a session for an invalid user account.");
            }

            var encryptedGuid = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(userAccount.Guid));
            return new SessionInfo
            {
                AccessToken = JwtUtils.GenerateToken(encryptedGuid),
                RefreshToken = JwtUtils.GenerateToken(encryptedGuid),
                FirstName = userAccount.FirstName,
                LastName = userAccount.LastName,
                SessionId = Guid.NewGuid().ToString(),
                SessionStart = DateTime.UtcNow.ToString("O"),
                UserName = userAccount.UserName,
                AccountType = userAccount.AccountType,
                Roles = userAccount.Roles
            };
        }
    }
}
