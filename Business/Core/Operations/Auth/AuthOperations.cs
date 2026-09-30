using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Toolbox.Generic;
using Toolbox.Security.Jwt;
using Toolbox.Security.Url;
using Toolbox.Text;

namespace Business.Core.Operations
{
    public class AuthOperations : _BaseOperations
    {
        private const int MaxUserNameLength = 320;
        private readonly BusinessContext db;
        private readonly AuthPasswordOperations authPasswordOperations;

        public AuthOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
            authPasswordOperations = new AuthPasswordOperations(context);
        }

        /// <summary>
        /// Authenticates a user while keeping database work asynchronous and request-cancellable.
        /// LDAP authentication remains delegated to the existing directory adapter, but database
        /// admission, account discovery, bootstrap persistence and password-rehash persistence all
        /// honor the request cancellation token.
        /// </summary>
        public async Task<ServiceResult<SessionInfo>> LoginUserAsync(
            UserAccountLoginViewModel viewModel,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var validationResult = validateLoginViewModel(viewModel);
            if (!validationResult.IsSuccess)
            {
                return new ServiceResult<SessionInfo>(ServiceResultType.Error, validationResult.Message, null);
            }

            var username = NormalizeUserName(viewModel.UserName);
            if (username.Length == 0 || username.Length > MaxUserNameLength)
            {
                return InvalidCredentials();
            }

            // Materialize only the small set of fields required by authentication. A bounded take
            // prevents corrupt duplicate rows from turning one login into an unbounded materialization.
            var accounts = await db.UserAccounts
                .Where(x => x.UserName.ToLower().Trim() == username && !x.IsDeleted && x.IsActive)
                .OrderBy(x => x.Id)
                .Take(2)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            // UserName is an authentication identity. Ambiguous active identities fail closed rather
            // than selecting an arbitrary row and potentially issuing a token for the wrong account.
            if (accounts.Count > 1)
            {
                return InvalidCredentials();
            }

            var account = accounts.Count == 1 ? accounts[0] : null;
            var atIndex = username.LastIndexOf('@');
            var ldapUsername = atIndex > 0 ? username.Substring(0, atIndex) : username;
            var domainName = atIndex > 0 && atIndex < username.Length - 1
                ? username.Substring(atIndex + 1)
                : string.Empty;

            var ldapDomain = Configuration.LDAP_DOMAIN?.Trim();
            if (ShouldAttemptLdap(domainName, ldapDomain))
            {
                cancellationToken.ThrowIfCancellationRequested();
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
                    cancellationToken.ThrowIfCancellationRequested();
                    var userAccount = account;
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
                        await db.UserAccounts.AddAsync(userAccount, cancellationToken).ConfigureAwait(false);
                        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
                    }
                    else if (userAccount.AccountType != UserAccountType.LDAP)
                    {
                        // An external account must never be silently promoted into a directory account.
                        return InvalidCredentials();
                    }

                    return new ServiceResult<SessionInfo>(
                        ServiceResultType.Success,
                        createSession(userAccount));
                }
            }

            if (account == null || account.AccountType != UserAccountType.EXTERNAL)
            {
                return InvalidCredentials();
            }

            if (!authPasswordOperations.VerifyPassword(
                    viewModel.Password,
                    account.Password,
                    account.Salt,
                    out var needsRehash))
            {
                return InvalidCredentials();
            }

            if (needsRehash)
            {
                cancellationToken.ThrowIfCancellationRequested();
                account.Password = authPasswordOperations.HashPassword(viewModel.Password);
                account.Salt = string.Empty;
                db.Entry(account).Property(x => x.Password).IsModified = true;
                db.Entry(account).Property(x => x.Salt).IsModified = true;
                await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            }

            return new ServiceResult<SessionInfo>(
                ServiceResultType.Success,
                createSession(account));
        }

        /// <summary>
        /// Source-compatible synchronous entry point for legacy callers. HTTP controllers should use
        /// <see cref="LoginUserAsync"/> so request cancellation can flow to EF Core.
        /// </summary>
        public ServiceResult<SessionInfo> LoginUser(UserAccountLoginViewModel viewModel)
        {
            return LoginUserAsync(viewModel, CancellationToken.None).GetAwaiter().GetResult();
        }

        public ServiceResult LogoutUser(UserSessionViewModel session)
        {
            // Access tokens are short-lived and signed. Server-side revocation/session persistence
            // is intentionally tracked as a separate migration before refresh tokens are relied on.
            return new ServiceResult(ServiceResultType.Success);
        }

        public async Task<ServiceResult> ChangePasswordFromProfileAsync(
            UserAccountChangePasswordViewModel viewModel,
            ClientRequestInfo info,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
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

            var userAccount = await db.UserAccounts
                .FirstOrDefaultAsync(
                    x => x.Id == session.UserId && !x.IsDeleted && x.IsActive,
                    cancellationToken)
                .ConfigureAwait(false);
            if (userAccount == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı bulunamadı");
            }

            if (userAccount.AccountType != UserAccountType.EXTERNAL)
            {
                return new ServiceResult(ServiceResultType.Error, "Bu hesap türünün parolası uygulama üzerinden değiştirilemez");
            }

            if (!authPasswordOperations.VerifyPassword(
                    viewModel.OldPassword,
                    userAccount.Password,
                    userAccount.Salt,
                    out _))
            {
                return new ServiceResult(ServiceResultType.Error, "Wrong username or password");
            }

            cancellationToken.ThrowIfCancellationRequested();
            userAccount.Password = authPasswordOperations.HashPassword(viewModel.NewPassword);
            userAccount.Salt = string.Empty;
            userAccount.SetUpdate(session.UserId);
            db.Entry(userAccount).State = EntityState.Modified;
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            return new ServiceResult(ServiceResultType.Success, "");
        }

        public ServiceResult ChangePasswordFromProfile(
            UserAccountChangePasswordViewModel viewModel,
            ClientRequestInfo info,
            UserSessionViewModel session)
        {
            return ChangePasswordFromProfileAsync(viewModel, info, session, CancellationToken.None)
                .GetAwaiter()
                .GetResult();
        }

        private ServiceResult validateLoginViewModel(UserAccountLoginViewModel viewModel)
        {
            if (viewModel == null || string.IsNullOrWhiteSpace(viewModel.UserName))
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı adı boş olamaz");
            }

            if (viewModel.UserName.Trim().Length > MaxUserNameLength)
            {
                return new ServiceResult(ServiceResultType.Error, "Wrong username or password");
            }

            // Login accepts legacy password lengths so an existing account can authenticate once
            // and be transparently rehashed. New password writes use the stronger policy.
            if (string.IsNullOrEmpty(viewModel.Password) || viewModel.Password.Length > Configuration.MAX_PASSWORD_LENGTH)
            {
                return new ServiceResult(ServiceResultType.Error, "Wrong username or password");
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        private static string NormalizeUserName(string userName)
        {
            if (string.IsNullOrWhiteSpace(userName)) return string.Empty;
            return TextUtils.CleanString(userName.Trim().ToLowerInvariant());
        }

        private static bool ShouldAttemptLdap(string domainName, string ldapDomain)
        {
            return !string.IsNullOrWhiteSpace(ldapDomain) &&
                   !string.IsNullOrWhiteSpace(Configuration.LDAP_SERVER) &&
                   string.Equals(domainName, ldapDomain, StringComparison.OrdinalIgnoreCase);
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
