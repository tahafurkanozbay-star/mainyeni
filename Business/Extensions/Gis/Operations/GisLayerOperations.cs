using System;
using System.Collections.Generic;
using System.Linq;
using Toolbox.Validation;
using Toolbox.Security.Url;
using Toolbox.Serialization;
using Toolbox.Text;
using Business._Base;
using Business.Core.Context;
using Business.Core.Common;
using Business.Extensions.Gis.Model;
using Microsoft.EntityFrameworkCore;
using Business.Extensions.Gis.ViewModel;
using Business.Core.ViewModel;
using Business.Core.Resources;

namespace Business.Extensions.Gis.Operations
{
    public class GisLayerOperations : _BaseOperations
    {

        private BusinessContext db;

        public GisLayerOperations(BusinessContext context)
        {
            this.db = context;
        }


        public ServiceResult Create(GisLayerAdminViewModel viewModel, UserSessionViewModel session)
        {
                var validateResult = ValidateCreate(viewModel);
                if (validateResult.IsSuccess)
                {

                    using (db)
                    {
                        if (!viewModel.RequiresSC)
                        {
                            viewModel.RequiresSC = false;
                            viewModel.SCUserName = "";
                            viewModel.SCPassword = "";
                        }

                        GisLayer model = new GisLayer();
                    

                        if (viewModel.RequiresSC)
                        {
                            model.RequiresSC = true;
                            model.SCUserName = viewModel.SCUserName;
                            model.SCPassword = viewModel.SCPassword;
                        }
                        else
                        {
                            model.RequiresSC = false;
                            model.SCUserName = "";
                            model.SCPassword = "";
                        }

                    
                        bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                        if (!urlIsValid)
                        {
                            return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("INVALID_URL"));
                        }
                        model.Url = viewModel.Url.Trim();

                        model.AdditionalInfo = viewModel.AdditionalInfo;
                        model.LayerType = viewModel.LayerType;
                        model.GisLayerGroupId = viewModel.GisLayerGroupId;
                        model.Title = TextUtils.Capitalize(viewModel.Title.Trim());
                        model.OrderPriority=viewModel.OrderPriority;
                        model.StartupOpacity = viewModel.StartupOpacity;
                        model.VisibleAtStartup = viewModel.VisibleAtStartup;
                        model.IsSwipeLayer = viewModel.IsSwipeLayer;
                        model.IsTimelineLayer = viewModel.IsTimelineLayer;
                        model.Description = viewModel.Description;

                        model.SetCreate(session.UserId);
                        db.GisLayers.Add(model);
                        db.SaveChanges();

                        return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("SAVED"));
                    }

                }
                else
                {
                    return validateResult;
                }

          
        }

        public ServiceResult<GisLayer> GetByEncryptedGuid(string eg)
        {
                string guid = ParameterEncryptionUtils.DecryptGuid(eg).ToString();
                GisLayer layer = GetLayerByGuid(guid);
                return new ServiceResult<GisLayer>(ServiceResultType.Success, "", layer);
            
        }

        public ServiceResult Update(GisLayerAdminViewModel viewModel, UserSessionViewModel session)
        {
                var validateResult = ValidateUpdate(viewModel);
                if (validateResult.IsSuccess)
                {
                    using (db)
                    {
                        GisLayer model = db.GisLayers.Where(x=>x.Id==viewModel.Id && !x.IsDeleted).FirstOrDefault();

                        if (viewModel.RequiresSC)
                        {
                            model.RequiresSC = true;
                            model.SCUserName = viewModel.SCUserName;
                            model.SCPassword = viewModel.SCPassword;
                        }
                        else
                        {
                            model.RequiresSC = false;
                            model.SCUserName = "";
                            model.SCPassword = "";
                        }

                        
                        bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                        if (!urlIsValid)
                        {
                            return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("INVALID_URL"));
                        }
                        model.Url = viewModel.Url.Trim();


                        model.AdditionalInfo = viewModel.AdditionalInfo;
                        model.Description = viewModel.Description;
                        model.GisLayerGroupId = viewModel.GisLayerGroupId;
                        model.IsSwipeLayer = viewModel.IsSwipeLayer;
                        model.IsTimelineLayer = viewModel.IsTimelineLayer;
                        model.LayerType = viewModel.LayerType;
                        model.OrderPriority = viewModel.OrderPriority;
                        model.StartupOpacity = viewModel.StartupOpacity;
                        model.Title = TextUtils.Capitalize(viewModel.Title.Trim());
                        model.VisibleAtStartup = viewModel.VisibleAtStartup;
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

        private ServiceResult ValidateCreate(GisLayerAdminViewModel viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman adı boş olamaz");
            }
            
            if (TextUtils.IsNullOrEmpty(viewModel.Url))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman adresi boş olamaz");
            }
            else{
                bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                if (!urlIsValid)
                {
                    return new ServiceResult(ServiceResultType.Error, "Lütfen geçerli br bağlantı adresi giriniz");
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

            return new ServiceResult(ServiceResultType.Success);
        }

        private ServiceResult ValidateUpdate(GisLayerAdminViewModel viewModel)
        {
            if (TextUtils.IsNullOrEmpty(viewModel.Title))
            {

                return new ServiceResult(ServiceResultType.Error, "Katman adı boş olamaz");
            }
            if (TextUtils.IsNullOrEmpty(viewModel.Url))
            {
                return new ServiceResult(ServiceResultType.Error, "Katman adresi boş olamaz");
            }
            else{
                bool urlIsValid = ValidationUtils.ValidateUrl(viewModel.Url);
                if (!urlIsValid)
                {
                    return new ServiceResult(ServiceResultType.Error, "Lütfen geçerli br bağlantı adresi giriniz");
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

            return new ServiceResult(ServiceResultType.Success);
        }

        public GisLayer GetLayerByGuid(string guid)
        {
            GisLayer layer = null;
            using (db)
            {
                layer = GetSingleItem<GisLayer>(db, x => x.Guid == guid && !x.IsDeleted && !x.IsDeleted);
            }
        
            return layer;
        }


        public GisLayer GetLayerByUrl(string url)
        {
            GisLayer layer = null;
            using (db)
            {
                layer = GetSingleItem<GisLayer>(db, x => (x.Url.Contains(url) || url.Contains(x.Url)) && !x.IsDeleted);
            }
        
            return layer;
        }

        

        public ServiceResult<List<GisLayer>> GetUngroupedLayers()
        {
            using (db)
            {
                var list = GetItemList<GisLayer>(db, x => !x.IsDeleted && x.GisLayerGroupId == -1).OrderBy(x => x.OrderPriority).ToList();
                return new ServiceResult<List<GisLayer>>(ServiceResultType.Success, "", list);
            }
        

        }

        public ServiceResult<List<GisLayerGroup>> GetLayerGroups()
        {
            using (db)
            {
                var list = GetItemList<GisLayerGroup>(db, x => !x.IsDeleted, y => y.Layers).OrderBy(x => x.OrderPriority).ToList();
                return new ServiceResult<List<GisLayerGroup>>(ServiceResultType.Success, "", list);
            }
        
        }

        public ServiceResult<List<GisLayer>> GetAll()
        {
            using (db)
            {

                var list = GetItemList<GisLayer>(db, x => !x.IsDeleted, y => y.LayerGroup).OrderBy(x => x.OrderPriority).ToList();

                //TODO: Grubu silinmiş katmanlar da gösterilmelidir
                //list.AddRange(ungroupedList);

                return new ServiceResult<List<GisLayer>>(ServiceResultType.Success, "", list);
            }
        
        }

     
        /// <summary>
        /// Reorder service order
        /// </summary>
        /// <param name="encryptedGuids"></param>
        public ServiceResult ReOrderGisLayers(string encryptedGuids)
        {
                //Change order priority
                List<String> encryptedGuidList = SerializationUtils.JsonToObject<List<String>>(encryptedGuids);

                using (db)
                {
                    int priority = 1;
                    foreach (String encryptedGuid in encryptedGuidList)
                    {
                        var getLayerResult = GetByEncryptedGuid(encryptedGuid);
                        if (getLayerResult.IsSuccess)
                        {
                            GisLayer layer = getLayerResult.Data;
                            layer.OrderPriority = priority;
                            priority++;
                            db.Entry(layer).State = EntityState.Modified;

                        }
                        else
                        {
                            return getLayerResult;
                        }
                    }

                    db.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success, "Katmanlar yeniden sıralandı");
                }
            


        }

        public ServiceResult Delete(int id, UserSessionViewModel userSession)
        {
            using (db)
            {
                
                GisLayer layer = GetSingleItem<GisLayer>(db, x => x.Id == id && !x.IsDeleted);
                if(layer!=null){
                    
                    layer.SetDelete(userSession.UserId);
                    db.Entry(layer).State=EntityState.Modified;
                    db.SaveChanges();
                    
                    return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("DELETED"));
                }
                else{
                    return new ServiceResult(ServiceResultType.Success,BusinessMessages.Get("NOT_FOUND"));
                }
                
            }
           

        }
    }
}