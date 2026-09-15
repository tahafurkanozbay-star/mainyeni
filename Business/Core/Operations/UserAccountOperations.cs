using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using Toolbox.Generic;
using Toolbox.Security.Password;
using Toolbox.Security.Url;
using Toolbox.Text;

namespace Business.Core.Operations
{
    public class UserAccountOperations : _BaseOperations
    {
        private readonly BusinessContext db;

        public UserAccountOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public ServiceResult Create(UserAccountUpdateViewModel viewModel, UserSessionViewModel session)
        {
            var validation = validateModel(viewModel);
            if (!validation.IsSuccess) return validation;
            if (session == null) return new ServiceResult(ServiceResultType.Error, "Geçersiz oturum");

            var normalizedUsername = viewModel.UserName.Trim().ToLowerInvariant();
            if (db.UserAccounts.Any(x => !x.IsDeleted && x.UserName.ToLower().Trim() == normalizedUsername))
            {
                return new ServiceResult(ServiceResultType.Error, "Bu kullanıcı adı zaten kayıtlı");
            }

            var model = new UserAccount
            {
                UserName = normalizedUsername,
                FirstName = TextUtils.Capitalize(viewModel.FirstName.Trim().ToLowerInvariant()),
                LastName = TextUtils.Capitalize(viewModel.LastName.Trim().ToLowerInvariant()),
                IsSuperUser = false,
                Roles = viewModel.Roles
            };

            if (viewModel.AccountType == (int)UserAccountType.LDAP)
            {
                var domainSeparator = normalizedUsername.LastIndexOf('@');
                var domain = domainSeparator > 0 && domainSeparator < normalizedUsername.Length - 1
                    ? normalizedUsername.Substring(domainSeparator + 1)
                    : string.Empty;

                if (string.IsNullOrWhiteSpace(Configuration.LDAP_DOMAIN) ||
                    !string.Equals(domain, Configuration.LDAP_DOMAIN, StringComparison.OrdinalIgnoreCase))
                {
                    return new ServiceResult(
                        ServiceResultType.Error,
                        "Kayıt oluşturulamadı, kurum kullanıcısı eposta adresi yapılandırılmış LDAP alan adı ile bitmelidir");
                }

                model.AccountType = UserAccountType.LDAP;
                model.IsActive = true;
                model.Salt = string.Empty;
                model.Password = "-";
            }
            else
            {
                model.AccountType = UserAccountType.EXTERNAL;
                model.IsActive = false;
                model.Salt = string.Empty;
                // Inactive external users receive an unguessable process-local bootstrap password.
                // An administrator must explicitly set a real password before activation/use.
                model.Password = GeneratePassword(Configuration.UserSettings_DefaultPassword, null);
            }

            model.SetCreate(session.UserId);
            db.UserAccounts.Add(model);
            db.SaveChanges();

            return new ServiceResult(ServiceResultType.Success, "Kayıt oluşturuldu");
        }

        public ServiceResult<DataList<UserAccountListViewModel>> List(
            _BaseSearchViewModel viewModel,
            UserSessionViewModel session)
        {
            if (viewModel == null || session == null)
            {
                return new ServiceResult<DataList<UserAccountListViewModel>>(
                    ServiceResultType.Error,
                    "Geçersiz istek",
                    null);
            }

            const int maxPageSize = 25;
            if (viewModel.PageSize > maxPageSize || viewModel.PageSize <= 0)
            {
                viewModel.PageSize = maxPageSize;
            }
            if (viewModel.PageNumber <= 0)
            {
                viewModel.PageNumber = 1;
            }

            var skipRows = (viewModel.PageNumber - 1) * viewModel.PageSize;
            var query = db.UserAccounts
                .AsNoTracking()
                .Where(x => !x.IsDeleted && x.Id != session.UserId && !x.IsSuperUser)
                .OrderBy(x => x.FirstName)
                .ThenBy(x => x.LastName);

            var count = query.Count();
            var pageRows = query
                .Skip(skipRows)
                .Take(viewModel.PageSize)
                .Select(user => new
                {
                    user.Guid,
                    user.FirstName,
                    user.LastName,
                    user.UserName,
                    user.Id,
                    user.Roles,
                    user.AccountType,
                    user.CreateDate
                })
                .ToList();

            // Opaque-id formatting is application code and must run after EF has materialized the
            // SQL-translatable projection. Doing this inside Select causes provider translation errors.
            var resultList = pageRows.Select(user => new UserAccountListViewModel
            {
                Eg = Guid.TryParse(user.Guid, out var guid)
                    ? ParameterEncryptionUtils.EncryptGuid(guid, Configuration.GENERIC_SALT)
                    : null,
                FirstName = user.FirstName,
                LastName = user.LastName,
                UserName = user.UserName,
                Id = user.Id,
                Roles = user.Roles,
                AccountType = user.AccountType,
                CreateDate = user.CreateDate
            }).ToList();

            return new ServiceResult<DataList<UserAccountListViewModel>>(
                ServiceResultType.Success,
                new DataList<UserAccountListViewModel>
                {
                    TotalRowCount = count,
                    CurrentPage = viewModel.PageNumber,
                    PageSize = viewModel.PageSize,
                    Data = resultList
                });
        }

        public ServiceResult Update(UserAccountUpdateViewModel viewModel, UserSessionViewModel session)
        {
            var validation = validateModel(viewModel);
            if (!validation.IsSuccess) return validation;
            if (session == null) return new ServiceResult(ServiceResultType.Error, "Geçersiz oturum");

            var model = db.UserAccounts.FirstOrDefault(x => x.Id == viewModel.Id && !x.IsDeleted);
            if (model == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Record not found (useraccount)");
            }

            var normalizedUsername = viewModel.UserName.Trim().ToLowerInvariant();
            if (db.UserAccounts.Any(x =>
                    x.Id != model.Id && !x.IsDeleted && x.UserName.ToLower().Trim() == normalizedUsername))
            {
                return new ServiceResult(ServiceResultType.Error, "Bu kullanıcı adı zaten kayıtlı");
            }

            model.UserName = normalizedUsername;
            model.FirstName = TextUtils.Capitalize(viewModel.FirstName.Trim().ToLowerInvariant());
            model.LastName = TextUtils.Capitalize(viewModel.LastName.Trim().ToLowerInvariant());
            model.IsSuperUser = false;
            model.Roles = viewModel.Roles;

            if (viewModel.AccountType == (int)UserAccountType.LDAP)
            {
                model.AccountType = UserAccountType.LDAP;
                model.IsActive = true;
            }
            else
            {
                model.AccountType = UserAccountType.EXTERNAL;
                model.IsActive = false;
            }

            model.SetUpdate(session.UserId);
            db.Entry(model).State = EntityState.Modified;
            db.SaveChanges();

            return new ServiceResult(ServiceResultType.Success, "Record updated");
        }

        public ServiceResult UpdatePassword(
            UserAccount_AdminPasswordUpdateViewModel viewModel,
            UserSessionViewModel session)
        {
            var validation = validatePasswordUpdate(viewModel);
            if (!validation.IsSuccess) return validation;
            if (session == null) return new ServiceResult(ServiceResultType.Error, "Geçersiz oturum");

            var model = db.UserAccounts.FirstOrDefault(x => x.Id == viewModel.Id && !x.IsDeleted);
            if (model == null)
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
            }
            if (model.AccountType != UserAccountType.EXTERNAL)
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("CANNOT_BE_CHANGED"));
            }

            model.Salt = string.Empty;
            model.Password = GeneratePassword(viewModel.password, null);
            model.SetUpdate(session.UserId);
            db.Entry(model).State = EntityState.Modified;
            db.SaveChanges();

            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPDATED"));
        }

        public ServiceResult Delete(UserAccountUpdateViewModel viewModel, UserSessionViewModel session)
        {
            if (viewModel == null || session == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Geçersiz istek");
            }

            var model = GetEntityByEncryptedGuid<UserAccount>(db, viewModel.Eg);
            if (model == null)
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
            }

            model.SetDelete(session.UserId);
            db.Entry(model).State = EntityState.Modified;
            db.SaveChanges();
            return new ServiceResult(ServiceResultType.Success, "Kayıt silindi");
        }

        private ServiceResult validateModel(UserAccountUpdateViewModel viewModel)
        {
            if (viewModel == null) return new ServiceResult(ServiceResultType.Error, "Geçersiz istek");
            if (string.IsNullOrWhiteSpace(viewModel.UserName))
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı adı boş olamaz");
            if (string.IsNullOrWhiteSpace(viewModel.FirstName))
                return new ServiceResult(ServiceResultType.Error, "İsim boş olamaz");
            if (string.IsNullOrWhiteSpace(viewModel.LastName))
                return new ServiceResult(ServiceResultType.Error, "Soyad boş olamaz");
            if (string.IsNullOrWhiteSpace(viewModel.Roles))
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı rolleri boş olamaz");
            if (viewModel.AccountType <= 0)
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı tipi boş olamaz");

            return new ServiceResult(ServiceResultType.Success);
        }

        private ServiceResult validatePasswordUpdate(UserAccount_AdminPasswordUpdateViewModel viewModel)
        {
            if (viewModel == null || string.IsNullOrEmpty(viewModel.password))
                return new ServiceResult(ServiceResultType.Error, "Şifre boş olamaz");
            if (viewModel.password != viewModel.passwordRepeat)
                return new ServiceResult(ServiceResultType.Error, "Şifre ve şifre tekrarı birbiriyle uyumlu değil");
            if (viewModel.password.Length < Configuration.MIN_PASSWORD_LENGTH)
                return new ServiceResult(ServiceResultType.Error, $"Şifre en az {Configuration.MIN_PASSWORD_LENGTH} karakter olmalıdır");
            if (viewModel.password.Length > Configuration.MAX_PASSWORD_LENGTH)
                return new ServiceResult(ServiceResultType.Error, $"Şifre en fazla {Configuration.MAX_PASSWORD_LENGTH} karakter olmalıdır");

            return new ServiceResult(ServiceResultType.Success);
        }

        /// <summary>
        /// Generates the current versioned one-way password hash. The legacy salt argument is
        /// retained for source compatibility and intentionally ignored for new writes.
        /// </summary>
        public static string GeneratePassword(string plainText, string salt)
        {
            return PasswordUtils.HashPassword(plainText);
        }
    }
}
