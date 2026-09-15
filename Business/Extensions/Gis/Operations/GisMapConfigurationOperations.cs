using Toolbox.Serialization;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Operations;
using Business.Core.Model;
using Business.Core.ViewModel;
using Business.Extensions.Gis.ViewModel;

namespace Business.Core.Operations
{
    public class GisMapConfigurationOperations : _BaseOperations
    {
        private BusinessContext db;

        private AppConfigOperations appConfigOperations { get; set; }

        public GisMapConfigurationOperations(BusinessContext context)
        {
            this.db=context;
            this.appConfigOperations = new AppConfigOperations(context);
        }

        public ServiceResult<GisMapConfigurationViewModel> Get()
        {
                var result = appConfigOperations.GetConfig(Configuration.GIS_MAP_CONFIG_KEY);

                if (result.IsSuccess)
                {
                    var json = result.Data.ConfigValue;
                    var viewModel = SerializationUtils.JsonToObject<GisMapConfigurationViewModel>(json);

                    return new ServiceResult<GisMapConfigurationViewModel>(ServiceResultType.Success, "", viewModel);
                }
                else
                {
                    return new ServiceResult<GisMapConfigurationViewModel>(ServiceResultType.Error, "Konfigürasyon bulunamadı", null);

                }
         
        }
        
        public ServiceResult<GisMapConfigurationViewModel> Update(GisMapConfigurationViewModel viewModel, UserSessionViewModel session)
        {
                var configValue = SerializationUtils.ObjectToJson<GisMapConfigurationViewModel>(viewModel);

                var config = new AppConfig()
                {
                    ConfigKey = Configuration.GIS_MAP_CONFIG_KEY,
                    ConfigValue = configValue
                };

                var result = appConfigOperations.Update(config, session);
                if (result.IsSuccess)
                {
                    return new ServiceResult<GisMapConfigurationViewModel>(ServiceResultType.Success, result.Message, viewModel);
                }
                else
                {
                    return new ServiceResult<GisMapConfigurationViewModel>(ServiceResultType.Error, result.Message, null);
                }

          
        }

    }
}