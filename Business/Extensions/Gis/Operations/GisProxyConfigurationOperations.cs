using Toolbox.Serialization;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Operations;
using Business.Core.ViewModel;
using Business.Core.Model;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;

namespace Business.Extensions.Gis.Operations
{
    public class GisProxyConfigurationOperations : _BaseOperations
    {
        private AppConfigOperations appConfigOperations { get; set; }

        private readonly string configKey = "GisProxyConfig";

        private BusinessContext db;
        private BusinessContext gisDb;

        public GisProxyConfigurationOperations(BusinessContext context, BusinessContext gisContext)
        {
            this.db=context;
            this.gisDb = gisContext;
            this.appConfigOperations=new AppConfigOperations(context);
        }

        public ServiceResult<GisProxyConfigurationViewModel> Get()
        {
                var result = appConfigOperations.GetConfig(configKey);

                if (result.IsSuccess)
                {
                    var json = result.Data.ConfigValue;
                    var viewModel = SerializationUtils.JsonToObject<GisProxyConfigurationViewModel>(json);

                    return new ServiceResult<GisProxyConfigurationViewModel>(ServiceResultType.Success, "", viewModel);
                }
                else
                {
                    return new ServiceResult<GisProxyConfigurationViewModel>(ServiceResultType.Error, "Konfigürasyon bulunamadı", null);
                }
        }

        public ServiceResult<GisProxyConfigurationViewModel> Update(GisProxyConfigurationViewModel viewModel, UserSessionViewModel session)
        {
                var configValue = SerializationUtils.ObjectToJson<GisProxyConfigurationViewModel>(viewModel);

                var config = new AppConfig()
                {
                    ConfigKey = configKey,
                    ConfigValue = configValue
                };

                var result = appConfigOperations.Update(config, session);
                if (result.IsSuccess)
                {
                    return new ServiceResult<GisProxyConfigurationViewModel>(ServiceResultType.Success, result.Message, viewModel);
                }
                else
                {
                    return new ServiceResult<GisProxyConfigurationViewModel>(ServiceResultType.Error, result.Message, null);
                }

        }

    }
}
