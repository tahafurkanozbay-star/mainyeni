using System;
using System.Collections.Generic;
using System.Linq;
using Toolbox.Serialization;
using Toolbox.Security.Url;
using Toolbox.Text;
using Business._Base;
using Business.Core.Context;
using Business.Core.Common;
using Business.Extensions.Gis.Model;
using Microsoft.EntityFrameworkCore;
using Business.Core.ViewModel;
using Business.Core.Resources;
using Business.Extensions.Gis.ViewModel;

namespace Business.Extensions.Gis.Operations
{
    public class GisLayerGroupOperations : _BaseOperations
    {

        private BusinessContext gisDb;

        public GisLayerGroupOperations(BusinessContext context)
        {
            this.gisDb = context;
        }

        public ServiceResult ValidateCreate(GisLayerGroup viewModel)
        {

            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman grubu adı boş olamaz");
            }
            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult ValidateUpdate(GisLayerGroup viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman grubu adı boş olamaz");
            }
            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult Create(GisLayerGroup viewModel, UserSessionViewModel session)
        {
            var validateResult = ValidateCreate(viewModel);
            if (validateResult.IsSuccess)
            {

                using (gisDb)
                {

                    var model = new GisLayerGroup();
                    model.SetCreate(session.UserId);

                    model.Title = TextUtils.Capitalize(viewModel.Title.Trim());
                    gisDb.GisLayerGroups.Add(model);
                    gisDb.SaveChanges();
                }
                return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("SAVED"));

            }
            else
            {
                return validateResult;
            }

        }

        public ServiceResult Update(GisLayerGroup viewModel, UserSessionViewModel session)
        {
            var validateResult = ValidateUpdate(viewModel);
            if (validateResult.IsSuccess)
            {
                using (gisDb)
                {
                    var model = gisDb.GisLayerGroups.Where(x => x.Id == viewModel.Id && !x.IsDeleted).FirstOrDefault();

                    model.Title = TextUtils.Capitalize(viewModel.Title.Trim());
                    model.SetUpdate(session.UserId);

                    gisDb.Entry(model).State = EntityState.Modified;
                    gisDb.SaveChanges();
                }

                return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPDATED"));

            }
            else
            {
                return validateResult;
            }
        }

        public ServiceResult Delete(GisLayerGroup viewModel, UserSessionViewModel session)
        {
            using (gisDb)
            {
                //TODO: Get sublayers & update their group id

                GisLayerGroup model = GetSingleItem<GisLayerGroup>(gisDb, x => x.Id == viewModel.Id);

                //Grup silinmeden önce gruptaki katmanlar taşınmalı
                var gisLayers = gisDb.GisLayers.Where(x => x.GisLayerGroupId == model.Id).ToList();
                foreach (var item in gisLayers)
                {
                    item.GisLayerGroupId = -1;
                    gisDb.Entry(item).State = EntityState.Modified;
                }

                model.SetDelete(session.UserId);
                gisDb.Entry(model).State = EntityState.Modified; ;
                gisDb.SaveChanges();

                return new ServiceResult(ServiceResultType.Success, "Başarıyla silindi");
            }
        }

        public ServiceResult ReorderItems(string encryptedGuids)
        {
            List<String> encryptedGuidList = SerializationUtils.JsonToObject<List<String>>(encryptedGuids);

            using (gisDb)
            {
                int priority = 1;
                foreach (String encryptedGuid in encryptedGuidList)
                {
                    var getLayerGroupResult = GetByEncryptedGuid(encryptedGuid);
                    if (getLayerGroupResult.IsSuccess)
                    {
                        GisLayerGroup model = getLayerGroupResult.Data;
                        model.OrderPriority = priority;
                        priority++;
                        gisDb.Entry(model).State = EntityState.Modified;

                    }
                    else
                    {
                        return getLayerGroupResult;
                    }
                }

                gisDb.SaveChanges();

                return new ServiceResult(ServiceResultType.Success, "Katman grupları yeniden sıralandı");
            }


        }

        public ServiceResult<List<GisLayerGroupAdminViewModel>> GetAll()
        {
            using (gisDb)
            {
                var list = GetItemList<GisLayerGroup>(gisDb, x => !x.IsDeleted).OrderBy(x => x.Title).Select(x => new GisLayerGroupAdminViewModel()
                {
                    Id = x.Id,
                    Title = x.Title,
                }).ToList();
                return new ServiceResult<List<GisLayerGroupAdminViewModel>>(ServiceResultType.Success, "", list);
            }

        }


        public ServiceResult<List<GisLayerGroupAdminViewModel>> GetAllWithLayersForAdmin()
        {
            using (gisDb)
            {
                var list = GetItemList<GisLayerGroup>(gisDb, _group => !_group.IsDeleted, _group => _group.Layers).OrderBy(_group => _group.Title).Select(_group => new GisLayerGroupAdminViewModel()
                {
                    Id = _group.Id,
                    Title = _group.Title,
                    Layers = _group.Layers.Where(a => !a.IsDeleted).Select(x => new GisLayerAdminViewModel()
                    {
                        AdditionalInfo = x.AdditionalInfo,
                        Description = x.Description,
                        GisLayerGroupId = x.GisLayerGroupId,
                        Id = x.Id,
                        IsSwipeLayer = x.IsSwipeLayer,
                        IsTimelineLayer = x.IsTimelineLayer,
                        LayerType = x.LayerType,
                        OrderPriority = x.OrderPriority,
                        RequiresSC = x.RequiresSC,
                        SCPassword = x.SCPassword,
                        SCUserName = x.SCUserName,
                        StartupOpacity = x.StartupOpacity,
                        Title = x.Title,
                        Url = x.Url,
                        VisibleAtStartup = x.VisibleAtStartup
                    }).ToList()
                }).ToList();
                return new ServiceResult<List<GisLayerGroupAdminViewModel>>(ServiceResultType.Success, "", list);
            }

        }

        public ServiceResult<List<GisLayerGroupViewModel>> GetAllWithLayersForUser()
        {
            using (gisDb)
            {
                var list = GetItemList<GisLayerGroup>(gisDb, _group => !_group.IsDeleted, _group => _group.Layers).OrderBy(_group => _group.Title).Select(_group => new GisLayerGroupViewModel()
                {
                    Id = _group.Id,
                    Title = _group.Title,
                    Layers = _group.Layers.Where(a => !a.IsDeleted).Select(x => new GisLayerViewModel()
                    {
                        AdditionalInfo = x.AdditionalInfo,
                        Description = x.Description,
                        Id = x.Id,
                        IsSwipeLayer = x.IsSwipeLayer,
                        IsTimelineLayer = x.IsTimelineLayer,
                        LayerType = x.LayerType,
                        Priority = x.OrderPriority,
                        Opacity = x.StartupOpacity,
                        Title = x.Title,
                        //Url = x.Url,
                        Visible = x.VisibleAtStartup,
                        Eg= "https://"+ Toolbox.Security.Url.ParameterEncryptionUtils.EncryptGuid(x.Guid)+".gissrv.org"
                    }).ToList()
                }).ToList();
                return new ServiceResult<List<GisLayerGroupViewModel>>(ServiceResultType.Success, "", list);
            }

        }


        public ServiceResult<GisLayerGroup> GetByEncryptedGuid(string eg)
        {
            GisLayerGroup layer = null;

            string guid = ParameterEncryptionUtils.DecryptGuid(eg).ToString();
            using (gisDb)
            {
                layer = GetEntityByGuid<GisLayerGroup>(gisDb, guid);
            }
            return new ServiceResult<GisLayerGroup>(ServiceResultType.Success, "", layer);

        }

    }
}
