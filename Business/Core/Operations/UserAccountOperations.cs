using System.Security.AccessControl;
using System;
using Business._Base;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Business.Core.Common;
using Toolbox.Security;
using Toolbox.Security.Cryptography;
using Toolbox.Security.Password;
using Toolbox.Security.Url;
using Toolbox.Text;
using System.Linq;
using System.Collections.Generic;
using System.Linq.Expressions;
using Toolbox.Date;
using Business.Core.Resources;

namespace Business.Core.Operations
{
    
    public class UserAccountOperations : _BaseOperations
    {
        private BusinessContext db;

        public UserAccountOperations(BusinessContext context)
        {
            this.db = context;
        }
        
        public ServiceResult Create(UserAccountUpdateViewModel viewModel, UserSessionViewModel session)
        {
            //TODO: aynı username e sahip başka bir kullanıcı varsa tanımlanmaması lazım
            var validateResult = validateModel(viewModel);
            if (validateResult.IsSuccess)
            {
                var model = new UserAccount();
                model.UserName = viewModel.UserName.Trim().ToLower();
                model.FirstName = TextUtils.Capitalize(viewModel.FirstName.Trim().ToLower());
                model.LastName = TextUtils.Capitalize(viewModel.LastName.Trim().ToLower());
                
                //Super user system üzerinden oluşturulamaz
                model.IsSuperUser = false;
                
                if (viewModel.AccountType == 0) //LDAP User
                {
                    model.AccountType = UserAccountType.LDAP;
                    model.IsActive = true; //Kurum içi kullanıcılar otomatik olarak onaylanacaktır
                    model.Roles = viewModel.Roles; //Kurum içi kullanıcılar seçilen role atanacaktır

                    var ldapDomain= model.UserName.Split("@")[1];
                    
                    if(ldapDomain!=Configuration.LDAP_DOMAIN){
                          return new ServiceResult(ServiceResultType.Error, "Kayıt oluşturulamadı, kurum kullanıcısı eposta adresi '"+Configuration.LDAP_DOMAIN+"' ile bitmelidir");
                    }
                }
                else
                {
                    model.AccountType = UserAccountType.EXTERNAL;
                    model.IsActive = false; //Kurum dışı kullanıcılar elle kullanıcı tarafından onaylanacaktır
                    model.Roles = viewModel.Roles; //Kurum dışı tüm kullanıcılar harici user olarak kayıt edilecektir

                    var salt = CryptoUtils.CreateRandomSalt();
                    model.Salt = salt;
                    String cryptedPassword = GeneratePassword(Configuration.UserSettings_DefaultPassword, salt);
                    model.Password = cryptedPassword;
                }


                using (db)
                {
                    model.SetCreate(session.UserId);

                    db.UserAccounts.Add(model);
                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, "Kayıt oluşturuldu");
                }
            }
            else
            {
                return validateResult;
            }
        }

        public ServiceResult<DataList<UserAccountListViewModel>> List(_BaseSearchViewModel viewModel, UserSessionViewModel session)
        {
            using (db)
            {
                int pageSize = 25;
                if (viewModel.PageSize > pageSize || viewModel.PageSize <= 0)
                {
                    viewModel.PageSize = pageSize;
                }

                if (viewModel.PageNumber == 0)
                {
                    viewModel.PageNumber = 1;
                }
                int skipRows = (viewModel.PageNumber- 1) * viewModel.PageSize;

                var list = db.UserAccounts.Where(x => !x.IsDeleted && x.Id != session.UserId && !x.IsSuperUser).OrderBy(x => x.FirstName).ThenBy(x => x.LastName);

                var count = list.Count();
                
                var resultList = list.Skip(skipRows).Take(viewModel.PageSize).Select(y => new UserAccountListViewModel()
                {
                    Eg = ParameterEncryptionUtils.EncryptGuid(Guid.Parse(y.Guid),Configuration.GENERIC_SALT),
                    FirstName = y.FirstName,
                    LastName = y.LastName,
                    UserName = y.UserName,
                    Id=y.Id,
                    Roles=y.Roles,
                    AccountType=y.AccountType,
                    CreateDate=y.CreateDate
                }).ToList();

                var dataList = new DataList<UserAccountListViewModel>()
                {
                    TotalRowCount = count,
                    CurrentPage = viewModel.PageNumber,
                    PageSize = viewModel.PageSize,
                    Data = resultList
                };

                return new ServiceResult<DataList<UserAccountListViewModel>>(ServiceResultType.Success, dataList);
            }

        }

        public ServiceResult Update(UserAccountUpdateViewModel viewModel, UserSessionViewModel session)
        {

            //TODO: aynı username e sahip başka bir kullanıcı varsa tanımlanmaması lazım
            var validateResult = validateModel(viewModel);
            if (validateResult.IsSuccess)
            {
                var model = db.UserAccounts.Where(x=>x.Id==viewModel.Id && !x.IsDeleted).FirstOrDefault();

                if (model!=null) {

                    model.UserName = viewModel.UserName.Trim().ToLower();
                    model.FirstName = TextUtils.Capitalize(viewModel.FirstName.Trim().ToLower());
                    model.LastName = TextUtils.Capitalize(viewModel.LastName.Trim().ToLower());

                    //Super user system üzerinden oluşturulamaz
                    model.IsSuperUser = false;

                    if (viewModel.AccountType == (int)UserAccountType.LDAP) //LDAP User
                    {
                        model.AccountType = UserAccountType.LDAP;
                        model.IsActive = true; //Kurum içi kullanıcılar otomatik olarak onaylanacaktır
                        model.Roles = viewModel.Roles; //Kurum içi kullanıcılar seçilen role atanacaktır
                    }
                    else
                    {
                      
                        model.AccountType = UserAccountType.EXTERNAL;
                        model.IsActive = false; //Kurum dışı kullanıcılar elle kullanıcı tarafından onaylanacaktır
                        model.Roles = viewModel.Roles; //Kurum dışı tüm kullanıcılar harici user olarak kayıt edilecektir
                    }

                    using (db)
                    {
                        model.SetUpdate(session.UserId);
                        db.Entry(model).State = Microsoft.EntityFrameworkCore.EntityState.Modified;
                        db.SaveChanges();

                        return new ServiceResult(ServiceResultType.Success, "Record updated");
                    }
                }
                else
                {
                    return new ServiceResult(ServiceResultType.Error, "Record not found (useraccount)");
                }
            }
            else
            {
                return validateResult;
            }

        }


        public ServiceResult UpdatePassword(UserAccount_AdminPasswordUpdateViewModel viewModel, UserSessionViewModel session)
        {
            //TODO: aynı username e sahip başka bir kullanıcı varsa tanımlanmaması lazım
            var validateResult = validatePasswordUpdate(viewModel);
            if (validateResult.IsSuccess)
            {
                var model = db.UserAccounts.Where(x => x.Id == viewModel.Id && !x.IsDeleted).FirstOrDefault();

                if (model != null)
                {

                    if (model.AccountType == UserAccountType.EXTERNAL) 
                    {
                        using (db)
                        {
                            var salt = CryptoUtils.CreateRandomSalt();
                            model.Salt = salt;
                            String cryptedPassword = GeneratePassword(viewModel.password, salt);
                            model.Password = cryptedPassword;

                            model.SetUpdate(session.UserId);
                            db.Entry(model).State = Microsoft.EntityFrameworkCore.EntityState.Modified;
                            db.SaveChanges();

                            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPDATED"));
                        }
                    }
                    else
                    {

                        return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("CANNOT_BE_CHANGED"));
                    }

                   
                }
                else
                {
                    return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
                }
            }
            else
            {
                return validateResult;
            }
        }


        public ServiceResult Delete(UserAccountUpdateViewModel viewModel, UserSessionViewModel session)
        {
            using (db)
            {
                var model = GetEntityByEncryptedGuid<Model.UserAccount>(db, viewModel.Eg);
                model.SetDelete(session.UserId);

                db.Entry(model).State = Microsoft.EntityFrameworkCore.EntityState.Modified;
                db.SaveChanges();
                return new ServiceResult(ServiceResultType.Success, "Kayıt silindi");
            }

        }

        private ServiceResult validateModel(UserAccountUpdateViewModel viewModel)
        {
            if (String.IsNullOrEmpty(viewModel.UserName))
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı adı boş olamaz");
            }
            if (String.IsNullOrEmpty(viewModel.FirstName))
            {
                return new ServiceResult(ServiceResultType.Error, "İsim boş olamaz");
            }
            if (String.IsNullOrEmpty(viewModel.LastName))
            {
                return new ServiceResult(ServiceResultType.Error, "Soyad boş olamaz");
            }
            
            if (String.IsNullOrEmpty(viewModel.Roles))
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı rolleri boş olamaz");
            }

            if (viewModel.AccountType <= 0)
            {
                return new ServiceResult(ServiceResultType.Error, "Kullanıcı tipi boş olamaz");
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        private ServiceResult validatePasswordUpdate(UserAccount_AdminPasswordUpdateViewModel viewModel)
        {
            if (String.IsNullOrEmpty(viewModel.password))
            {
                return new ServiceResult(ServiceResultType.Error, "Şifre boş olamaz");
            }
            else
            {
                if (viewModel.password != viewModel.passwordRepeat)
                {
                    return new ServiceResult(ServiceResultType.Error, "Şifre ve şifre tekrarı birbiriyle uyumlu değil");
                }
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        /// <summary>
        /// Generates a unidirectional hashed password with a given plainText and salt
        /// </summary>
        /// <param name="plainText"></param>
        /// <param name="salt"></param>
        /// <returns></returns>
        public static string GeneratePassword(string plainText, string salt)
        {
            string cryptedPassword = PasswordUtils.Encrypt(plainText, salt, new SHA1Encryptor());
            return cryptedPassword;
        }

    }
}