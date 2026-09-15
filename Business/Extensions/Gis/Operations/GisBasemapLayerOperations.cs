using System;
using System.Collections.Generic;
using System.Linq;
using Toolbox.Security.Url;
using Toolbox.Text;
using Toolbox.Validation;
using Business._Base;
using Business.Core.Common;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;
using Microsoft.EntityFrameworkCore;
using Business.Core.Context;

namespace Business.Extensions.Gis.Operations
{
    public class GisBasemapLayerOperations : _BaseOperations
    {

        private BusinessContext db;

        public GisBasemapLayerOperations(BusinessContext dbContext)
        {
            this.db = dbContext;
        }


        public ServiceResult Create(GisBasemapLayer layer, UserSessionViewModel session)
        {
            var validateResult = ValidateCreate(layer);
            if (validateResult.IsSuccess)
            {
                layer.SetCreate(session.UserId);

                using (db)
                {
                    if (!layer.RequiresSC)
                    {
                        layer.RequiresSC = false;
                        layer.SCUserName = "";
                        layer.SCPassword = "";
                    }


                    bool urlIsValid = ValidationUtils.ValidateUrl(layer.Url);
                    if (!urlIsValid)
                    {
                        return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("INVALID_URL"));
                    }

                    layer.Url = layer.Url.Trim();

                    layer.Title = TextUtils.Capitalize(layer.Title.Trim());
                    layer.Description = layer.Description?.Trim();

                    db.GisBasemapLayers.Add(layer);
                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("SAVED"));
                }
            }
            else
            {
                return validateResult;
            }

        }

        private ServiceResult ValidateCreate(GisBasemapLayer viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {

                return new ServiceResult(ServiceResultType.Error, "Katman adı boş olamaz");
            }
            if (TextUtils.IsNullOrEmpty(viewModel.Url))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman adresi boş olamaz");
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

            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult<GisBasemapLayer> GetByEncryptedGuid(string eg)
        {
            GisBasemapLayer layer = null;
            string guid = ParameterEncryptionUtils.DecryptGuid(eg).ToString();
            layer = getByGuid(guid);
            return new ServiceResult<GisBasemapLayer>(ServiceResultType.Success, "", layer);

        }

        public ServiceResult Update(GisBasemapLayer viewModel, UserSessionViewModel session)
        {

            var validateResult = ValidateUpdate(viewModel);
            if (validateResult.IsSuccess)
            {
                using (db)
                {
                    var model = db.GisBasemapLayers.Where(x => x.Id == viewModel.Id).FirstOrDefault();

                    model.RequiresSC = viewModel.RequiresSC;
                    if (model.RequiresSC)
                    {
                        if (TextUtils.IsNullOrEmpty(viewModel.SCUserName))
                        {
                            throw new Exception("Güvenli Bağlantı için bir kullanıcı adı gerekiyor");
                        }
                        if (TextUtils.IsNullOrEmpty(viewModel.SCPassword))
                        {
                            throw new Exception("Güvenli Bağlantı için bir şifre gerekiyor");
                        }

                        model.SCUserName = viewModel.SCUserName;
                        model.SCPassword = viewModel.SCPassword;
                    }
                    else
                    {
                        model.SCUserName = "";
                        model.SCPassword = "";
                    }

                    bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                    if (urlIsValid)
                    {
                        model.Url = viewModel.Url.Trim();
                    }

                    if (viewModel.ImageUrl != null)
                    {
                        model.ImageUrl = viewModel.ImageUrl.Trim();
                    }

                    if (viewModel.Title != null)
                    {
                        model.Title = TextUtils.Capitalize(viewModel.Title.Trim());
                    }

                    model.Description = viewModel.Description?.Trim();

                    model.SetUpdate(session.UserId);

                    db.Entry(model).State = EntityState.Modified;
                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPDATED"));
                }
            }
            else
            {

                return validateResult;
            }

        }


        private ServiceResult ValidateUpdate(GisBasemapLayer viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {

                return new ServiceResult(ServiceResultType.Error, "Katman adı boş olamaz");
            }
            if (TextUtils.IsNullOrEmpty(viewModel.Url))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman adresi boş olamaz");
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

            return new ServiceResult(ServiceResultType.Success);
        }


        public GisBasemapLayer getByGuid(string guid)
        {
            GisBasemapLayer layer = null;

            using (db)
            {
                layer = GetSingleItem<GisBasemapLayer>(db, x => x.Guid == guid && !x.IsDeleted && !x.IsDeleted);
            }

            return layer;
        }

        public ServiceResult<List<GisBasemapLayer>> GetAll()
        {

            using (db)
            {
                var list = GetItemList<GisBasemapLayer>(db, x => !x.IsDeleted).ToList();
                return new ServiceResult<List<GisBasemapLayer>>(ServiceResultType.Success, "", list);
            }

        }

        public ServiceResult<List<GisBasemapLayerViewModel>> GetAllWithBuiltinBasemapList()
        {
            List<GisBasemapLayerViewModel> list = null;

            List<GisBasemapLayer> layers = null;

            var layerResult = GetAll();
            if (layerResult.IsSuccess)
            {

                layers = layerResult.Data;

                list = layers.Select(x => new GisBasemapLayerViewModel
                {
                    Id = x.Id,
                    Title = x.Title,
                    Url = x.Url,
                    ThumbnailUrl = x.ImageUrl
                }).ToList();


                string[] builtinBasemaps =
                {
                        "topo",
                        "streets",
                        "satellite",
                        "hybrid",
                        "dark-gray",
                        "gray",
                        "national-geographic",
                        "oceans",
                        "osm",
                        "terrain",
                        "dark-gray-vector",
                        "gray-vector",
                        "streets-vector",
                        "streets-night-vector",
                        "streets-navigation-vector",
                        "topo-vector",
                        "streets-relief-vector"
                    };


                for (int i = 0; i < builtinBasemaps.Length; i++)
                {

                    list.Add(new GisBasemapLayerViewModel()
                    {
                        Title = builtinBasemaps[i]
                    }
                    );
                }

                return new ServiceResult<List<GisBasemapLayerViewModel>>(ServiceResultType.Success, "", list);
            }
            else
            {
                return new ServiceResult<List<GisBasemapLayerViewModel>>(ServiceResultType.Error, "Liste getirilirken bir hata oluştu", null);
            }


        }

        public ServiceResult Delete(int Id, UserSessionViewModel session)
        {
            using (db)
            {

                GisBasemapLayer layer = GetSingleItem<GisBasemapLayer>(db, x => x.Id == Id & !x.IsDeleted);
                if (layer != null)
                {

                    layer.SetDelete(session.UserId);
                    db.Entry(layer).State = EntityState.Modified;
                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("DELETED"));
                }
                else
                {
                    return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
                }
            }

        }


        public GisBasemapLayer GetLayerByUrl(string url)
        {
            GisBasemapLayer layer = null;
            using (db)
            {
                layer = GetSingleItem<GisBasemapLayer>(db, x => (x.Url.ToLower().Contains(url.ToLower()) || url.ToLower().Contains(x.Url.ToLower())) && !x.IsDeleted);
            }

            return layer;
        }
    }
}