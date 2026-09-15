using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Extensions.Gis.Model;

namespace Business.Core.Operations
{
    public partial class SystemOperations : _BaseOperations
    {
       
        private UserAccountOperations userOperations = null;
        private BusinessContext db;

        public SystemOperations(BusinessContext context)
        {
            db=context;
            userOperations = new UserAccountOperations(context);
        }

        public bool IsDatabaseConnectionExists()
        {
            var connExists = false;
            try
            {
                using (db)
                {
                    connExists = db.Database.CanConnect();
                }
            }
            catch (Exception ex)
            {
                connExists = false;
            }

            return connExists;
        }

        public ServiceResult CreateConfigurationServices(string appConfigurationFilePath)
        {
            try
            {
                List<GisConfigService> services = new List<GisConfigService>();

                using (var reader = new StreamReader(appConfigurationFilePath))
                {
                    while (!reader.EndOfStream)
                    {
                        var line = reader.ReadLine();
                        var values = line.Split(',');

                        var category = values[0];
                        var title = values[1];
                        var url = values[2];
                        var description = values[3];

                        services.Add(new GisConfigService() {
                            Category=category,
                            Title=title,
                            Url=url,
                            Description=description,
                            RequiresSC=false
                        });
                    }
                }

                services.ForEach(x => x.SetCreate(-1));

                using (db)
                {
                    db.GisConfigServices.RemoveRange(db.GisConfigServices.Where(x=> x.Id>0).ToList());
                    db.GisConfigServices.AddRange(services);
                    db.SaveChanges();
                }
            }
            catch (Exception ex)
            {
                return new ServiceResult(ServiceResultType.Error,"Konfigürasyon oluşturulurken hata oluştu: "+ex.Message);
            }
            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult CreateMapConfiguration(string configFilePath)
        {
            try
            {
                using (db)
                {
                    var json=File.ReadAllText(configFilePath);
                    var config = new AppConfig()
                    {
                        ConfigKey = Configuration.ConfigKey_GisMapConfig,
                        ConfigValue =json
                    };
                    config.SetCreate(-1);
                    
                    var oldconfig = db.AppConfigs.Where(x => x.ConfigKey == Configuration.ConfigKey_GisMapConfig).FirstOrDefault();
                    if (oldconfig!=null) {
                        db.AppConfigs.Remove(oldconfig);
                    }

                    db.AppConfigs.Add(config);
                    db.SaveChanges();

                }
            }
            catch (Exception ex)
            {
                return new ServiceResult(ServiceResultType.Error, "Harita konfigürasyonu oluşturulurken hata oluştu: " + ex.Message);
            }
            return new ServiceResult(ServiceResultType.Success);
        }
    }
}