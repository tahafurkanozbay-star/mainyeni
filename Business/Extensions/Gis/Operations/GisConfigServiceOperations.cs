using System.Data;
using Toolbox.Text;
using Toolbox.Security.Url;
using Toolbox.Validation;
using System;
using System.Collections.Generic;
using System.Linq;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;
using Microsoft.EntityFrameworkCore;
using System.IO;

namespace Business.Extensions.Gis.Operations
{
    public class GisConfigServiceOperations : _BaseOperations
    {
        private BusinessContext db;

        public GisConfigServiceOperations(BusinessContext context)
        {
            this.db = context;
        }

        public ServiceResult<List<GisServiceViewModel>> GetConfigurationServices()
        {
            using (db)
            {
                List<GisConfigService> serviceList = GetItemList<GisConfigService>(db, x => !x.IsDeleted);

                var list = serviceList.Select(x => new GisServiceViewModel()
                {
                    Title = x.Title,
                    Url = x.Url
                }).ToList();

                return new ServiceResult<List<GisServiceViewModel>>(ServiceResultType.Success, "", list);
            }
        }


        public ServiceResult<List<GisConfigService>> GetAll()
        {
            using (db)
            {
                var list = GetItemList<GisConfigService>(db, x => !x.IsDeleted).ToList();
                return new ServiceResult<List<GisConfigService>>(ServiceResultType.Success, "", list);
            }
        }

        public ServiceResult<List<GisConfigurationServiceUserViewModel>> GetAllForPublic()
        {
            using (db)
            {
                var list = GetItemList<GisConfigService>(db, x => !x.IsDeleted).Select(x => new GisConfigurationServiceUserViewModel()
                {
                    Title = x.Title,
                    //Url = x.Url,
                    IsIdentifiable = x.IsIdentifiable,
                    IdentifyLayers = x.IdentifyLayers,
                    ShowInSearch = x.ShowInSearch,
                    SearchCategoryTitle = x.SearchCategoryTitle,
                    Eg= "https://"+ Toolbox.Security.Url.ParameterEncryptionUtils.EncryptGuid(x.Guid)+".gissrv.org"
                }).ToList();
                return new ServiceResult<List<GisConfigurationServiceUserViewModel>>(ServiceResultType.Success, "", list);
            }
        }

        public ServiceResult<List<GisConfigServiceGroup>> GetAllGrouped()
        {
            using (db)
            {
                var list = GetItemList<GisConfigService>(db, x => !x.IsDeleted).OrderBy(x => x.Title).ToList();

                var subList = list.OrderBy(x => x.Category).GroupBy(x => x.Category).Select(group => new GisConfigServiceGroup
                {
                    GroupTitle = group.Key,
                    Services = group.ToList()
                }).ToList();

                return new ServiceResult<List<GisConfigServiceGroup>>(ServiceResultType.Success, "", subList);
            }

        }

        public ServiceResult<GisConfigService> GetByEncryptedGuid(string eg)
        {

            Guid guid = ParameterEncryptionUtils.DecryptGuid(eg);
            
            GisConfigService model = GetServiceByGuid(guid);

            return new ServiceResult<GisConfigService>(ServiceResultType.Success, "", model);

        }

        private GisConfigService GetServiceByGuid(Guid guid)
        {
            GisConfigService service = null;
            using (db)
            {
                service = GetSingleItem<GisConfigService>(db, x => x.Guid == guid.ToString() && !x.IsDeleted);
            }
            return service;
        }

        public GisConfigService GetServiceByUrl(string url)
        {
            GisConfigService service = null;
            using (db)
            {
                service = GetSingleItem<GisConfigService>(db, x => (x.Url.Contains(url) || url.Contains(x.Url)) && !x.IsDeleted);
            }
        
            return service;
        }


        public ServiceResult Update(GisConfigService viewModel, UserSessionViewModel session)
        {
            ServiceResult validateResult = ValidateUpdate(viewModel);
            if (!validateResult.IsSuccess)
            {

                return new ServiceResult(ServiceResultType.Error, validateResult.Message);
            }

            var model = db.GisConfigServices.Where(x => x.Id == viewModel.Id).FirstOrDefault();

            if (model != null)
            {
                using (db)
                {

                    //!Variable name not being allowed for change
                    //model.Title = updateModel.Title.Trim();
                    if (!viewModel.RequiresSC)
                    {
                        model.RequiresSC = false;
                        model.SCUserName = "";
                        model.SCPassword = "";
                    }
                    else
                    {
                        model.RequiresSC = true;
                        model.SCUserName = viewModel.SCUserName?.Trim();
                        model.SCPassword = viewModel.SCPassword;
                    }

                    if (!viewModel.IsIdentifiable)
                    {
                        model.IsIdentifiable = false;
                        model.IdentifyLayers = "";
                    }
                    else
                    {
                        model.IsIdentifiable = true;
                        model.IdentifyLayers = viewModel.IdentifyLayers?.Trim();
                    }

                    if (!viewModel.ShowInSearch)
                    {
                        model.ShowInSearch = false;
                        model.SearchCategoryTitle = "";
                    }
                    else
                    {
                        model.ShowInSearch = true;
                        model.SearchCategoryTitle = viewModel.SearchCategoryTitle?.Trim();
                    }

                    bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                    if (!urlIsValid)
                    {
                        return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("INVALID_URL"));
                    }
                    
                    model.Url = viewModel.Url.Trim();
                    

                    model.Title = viewModel.Title.Trim();
                    model.Category = viewModel.Category.Trim();
                    model.Url = viewModel.Url;
                    model.Description = viewModel.Description.Trim();

                    db.Entry(model).State = EntityState.Modified;
                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPDATED"));


                }
            }
            else
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
            }


        }

        private ServiceResult ValidateUpdate(GisConfigService viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Url))
            {
                return new ServiceResult(ServiceResultType.Error, "Servis adresi boş olamaz");
            }
            else
            {
                if (!ValidationUtils.ValidateUrl(viewModel.Url))
                {
                    return new ServiceResult(ServiceResultType.Error, "Servis adresi geçerli olmalıdır");
                }
            }

            if (viewModel.RequiresSC)
            {
                if (TextUtils.IsNullOrEmpty(viewModel.SCUserName))
                {
                    return new ServiceResult(ServiceResultType.Error, "Güvenli Bağlantı için bir kullanıcı adı gerekiyor");
                }
                if (TextUtils.IsNullOrEmpty(viewModel.SCPassword))
                {
                    return new ServiceResult(ServiceResultType.Error, "Güvenli Bağlantı için bir şifre gerekiyor");
                }
            }


            if (viewModel.ShowInSearch)
            {
                if (TextUtils.IsNullOrEmpty(viewModel.SearchCategoryTitle))
                {
                    return new ServiceResult(ServiceResultType.Error, "Arama kategorisi bir başlık gerekiyor");
                }
            }

            if (viewModel.IsIdentifiable)
            {
                if (TextUtils.IsNullOrEmpty(viewModel.IdentifyLayers))
                {
                    return new ServiceResult(ServiceResultType.Error, "Bilgi alınabilir katman numaraları gerekiyor");
                }
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult Create(GisConfigService viewModel, UserSessionViewModel session)
        {
            var validateResult = ValidateCreate(viewModel);
            if (validateResult.IsSuccess)
            {

                using (db)
                {
                    if (!viewModel.RequiresSC)
                    {
                        viewModel.SCUserName = "";
                        viewModel.SCPassword = "";
                    }
                    else
                    {
                        viewModel.SCUserName = viewModel.SCUserName?.Trim();
                    }

                    if (!viewModel.IsIdentifiable)
                    {
                        viewModel.IdentifyLayers = "";
                    }
                    else
                    {
                        viewModel.IdentifyLayers = viewModel.IdentifyLayers?.Trim();
                    }

                    if (!viewModel.ShowInSearch)
                    {
                        viewModel.SearchCategoryTitle = "";
                    }
                    else
                    {
                        viewModel.SearchCategoryTitle = viewModel.SearchCategoryTitle?.Trim();
                    }

                    bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                    if (!urlIsValid)
                    {
                        return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("INVALID_URL"));
                    }
                    viewModel.Url = viewModel.Url.Trim();

                    viewModel.Title = viewModel.Title.Trim();
                    viewModel.Category = viewModel.Category.Trim();

                    viewModel.SetCreate(session.UserId);

                    db.GisConfigServices.Add(viewModel);
                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("SAVED"));

                }
            }
            else
            {
                return validateResult;
            }


        }

        private ServiceResult ValidateCreate(GisConfigService viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {
                return new ServiceResult(ServiceResultType.Error, "Servis adı boş olamaz");
            }

            if (TextUtils.IsNullOrEmpty(viewModel.Url))
            {
                return new ServiceResult(ServiceResultType.Error, "Servis adresi boş olamaz");
            }
            else
            {
                if (!ValidationUtils.ValidateUrl(viewModel.Url))
                {
                    return new ServiceResult(ServiceResultType.Error, "Servis adresi geçerli olmalıdır");
                }
            }

            if (viewModel.RequiresSC)
            {
                if (TextUtils.IsNullOrEmpty(viewModel.SCUserName))
                {
                    return new ServiceResult(ServiceResultType.Error, "Güvenli Bağlantı için bir kullanıcı adı gerekiyor");
                }
                if (TextUtils.IsNullOrEmpty(viewModel.SCPassword))
                {
                    return new ServiceResult(ServiceResultType.Error, "Güvenli Bağlantı için bir şifre gerekiyor");
                }
            }


            if (viewModel.ShowInSearch)
            {
                if (TextUtils.IsNullOrEmpty(viewModel.SearchCategoryTitle))
                {
                    return new ServiceResult(ServiceResultType.Error, "Arama kategorisi bir başlık gerekiyor");
                }
            }

            if (viewModel.IsIdentifiable)
            {
                if (TextUtils.IsNullOrEmpty(viewModel.IdentifyLayers))
                {
                    return new ServiceResult(ServiceResultType.Error, "Bilgi alınabilir katman numaraları gerekiyor");
                }
            }

            return new ServiceResult(ServiceResultType.Success);
        }




        public ServiceResult Delete(GisConfigService service, UserSessionViewModel session)
        {
            using (db)
            {

                var model = db.GisConfigServices.Where(x => x.Id == service.Id).FirstOrDefault();

                model.SetDelete(session.UserId);
                db.Entry(model).State = EntityState.Modified;
                db.SaveChanges();

                return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("DELETED"));
            }


        }




        public ServiceResult Import(string fileName, Stream stream, UserSessionViewModel session)
        {
            try
            {
                List<GisConfigService> services = new List<GisConfigService>();

                using (var reader = new StreamReader(stream))
                {

                    while (!reader.EndOfStream)
                    {
                        var line = reader.ReadLine();

                        var values = line.Split(',');

                        var category = values[0].Replace("\"", "");
                        var title = values[1].Replace("\"", "");
                        var url = values[2].Replace("\"", "");
                        var description = values[3].Replace("\"", "");

                        var requiresSC = values[4].Replace("\"", "");
                        var scUserName = values[5].Replace("\"", "");
                        var scPassword = values[6].Replace("\"", "");

                        var IsIdentifiable = values[7].Replace("\"", "");
                        var IdentifyLayers = values[8].Replace("\"", "");

                        var ShowInSearch = values[9].Replace("\"", "");
                        var SearchCategoryTitle = values[10].Replace("\"", "");


                        services.Add(new GisConfigService()
                        {
                            Category = category,
                            Title = title,
                            Url = url,
                            Description = description,

                            RequiresSC = (requiresSC == "true") ? true : false,
                            SCUserName = (requiresSC == "true") ? scUserName : null,
                            SCPassword = (requiresSC == "true") ? scPassword : null,

                            IsIdentifiable = (IsIdentifiable == "true") ? true : false,
                            IdentifyLayers = (IsIdentifiable == "true") ? IdentifyLayers : null,

                            ShowInSearch = (ShowInSearch == "true") ? true : false,
                            SearchCategoryTitle = (ShowInSearch == "true") ? SearchCategoryTitle : null
                        });
                    }
                }


                services.ForEach(x => x.SetCreate(session.UserId));

                using (db)
                {
                    db.GisConfigServices.RemoveRange(db.GisConfigServices);
                    db.GisConfigServices.AddRange(services);
                    db.SaveChanges();
                }

            }
            catch (Exception ex)
            {
                return new ServiceResult(ServiceResultType.Error, "Konfigürasyon oluşturulurken hata oluştu: " + ex.Message);
            }
            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPLOADED"));
        }
    }
}