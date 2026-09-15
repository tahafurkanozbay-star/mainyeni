using System.Linq;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using Business.Core.Resources;

namespace Business.Core.Operations
{
    public class AppConfigOperations : _BaseOperations
    {
        private BusinessContext db;

        public AppConfigOperations(BusinessContext context)
        {
            this.db = context;
        }

        public ServiceResult<AppConfig> GetConfig(string key)
        {
           
                using(db)
                {

                    var configList = GetItemList<AppConfig>(db, x => !x.IsDeleted && x.ConfigKey==key);

                    AppConfig config = null;
                    if (configList!=null && configList.Count>0) {
                        config = configList.FirstOrDefault();
                    }
                    else
                    {
                        config = new AppConfig() {
                            ConfigKey=key,
                            ConfigValue="{}"
                        };
                    }

                    return new ServiceResult<AppConfig>(ServiceResultType.Success, "", config);
                }
          
        }

        public ServiceResult<AppConfig> Create(AppConfig viewModel, UserSessionViewModel session)
        {
                using(db)
                {
                    var model = new AppConfig();

                    if (model!=null)
                    {
                        model.SetCreate(session.UserId);
                        model.ConfigKey = viewModel.ConfigKey;
                        model.ConfigValue = viewModel.ConfigValue;
                        
                        db.AppConfigs.Add(model);

                        db.SaveChanges();

                        return new ServiceResult<AppConfig>(ServiceResultType.Success,BusinessMessages.Get("UPDATED"), viewModel);
                    }
                    else
                    {
                        return new ServiceResult<AppConfig>(ServiceResultType.Error, "Konfigürasyon bulunamadı", viewModel);
                    }

                }

        }

        public ServiceResult<AppConfig> Update(AppConfig viewModel, UserSessionViewModel session)
        {
                using(db)
                {
                    var model = GetByKey(viewModel.ConfigKey);

                    if (model != null)
                    {
                        model.ConfigKey = viewModel.ConfigKey;
                        model.ConfigValue = viewModel.ConfigValue;

                        model.SetUpdate(session.UserId);

                        db.Entry(model).State = EntityState.Modified;

                        db.SaveChanges();

                        return new ServiceResult<AppConfig>(ServiceResultType.Success, BusinessMessages.Get("UPDATED"), viewModel);
                    }
                    else
                    {
                        return Create(viewModel, session);
                    }
                }
            
        }

        public AppConfig GetByKey(string key)
        {
            AppConfig item = null;
                using(db)
                {
                    item = GetSingleItem<AppConfig>(db, x => x.ConfigKey == key && !x.IsDeleted && !x.IsDeleted);
                }
            return item;
        }
        
    }
}