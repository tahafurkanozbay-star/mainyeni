using Business._Base;
using Business.Core.Context;
using Business.Core.Common;
using Business.Core.Model;
using Business.Core.Operations;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;
using Toolbox.Serialization;
using Business.Core.ViewModel;

namespace Business.Extensions.Gis.Operations
{
    public class GisThirdPartyConfigOperations : _BaseOperations
    {
        private AppConfigOperations appConfigOperations = null;
        
        private BusinessContext db;
        private BusinessContext gisDb;

        public GisThirdPartyConfigOperations(BusinessContext context,BusinessContext gisContext)
        {
            this.db=context;
            this.gisDb = gisContext;
            this.appConfigOperations=new AppConfigOperations(context);
        }


        public ServiceResult<GisThirdPartyConfigurationViewModel> Get()
        {
                var result = appConfigOperations.GetConfig(Configuration.GIS_THIRD_PARTY_CONFIG_KEY);

                if (result.IsSuccess)
                {
                    var json = result.Data.ConfigValue;
                    var viewModel = SerializationUtils.JsonToObject<GisThirdPartyConfigurationViewModel>(json);

                    return new ServiceResult<GisThirdPartyConfigurationViewModel>(ServiceResultType.Success, "", viewModel);
                }
                else
                {
                    return new ServiceResult<GisThirdPartyConfigurationViewModel>(ServiceResultType.Error, "Konfigürasyon bulunamadı", null);

                }
         

        }

        public ServiceResult<GisThirdPartyConfigurationViewModel> Update(GisThirdPartyConfigurationViewModel viewModel, UserSessionViewModel session)
        {
                var configValue = SerializationUtils.ObjectToJson<GisThirdPartyConfigurationViewModel>(viewModel);

                var config = new AppConfig()
                {
                    ConfigKey = Configuration.GIS_THIRD_PARTY_CONFIG_KEY,
                    ConfigValue = configValue
                };

                var result = appConfigOperations.Update(config, session);
                if (result.IsSuccess)
                {
                    return new ServiceResult<GisThirdPartyConfigurationViewModel>(ServiceResultType.Success, result.Message, viewModel);
                }
                else
                {
                    return new ServiceResult<GisThirdPartyConfigurationViewModel>(ServiceResultType.Error, result.Message, null);
                }

           
        }
    }
}