using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Extensions.Gis.Model;
using Microsoft.EntityFrameworkCore;

namespace Business.Core.Operations
{
    public partial class SystemOperations : _BaseOperations
    {
        private const int MaxConfigurationFileBytes = 2 * 1024 * 1024;
        private const int MaxConfigurationServices = 2000;
        private const int MaxCategoryLength = 256;
        private const int MaxTitleLength = 512;
        private const int MaxUrlLength = 4096;
        private const int MaxDescriptionLength = 8192;
        private const int MaxMapConfigurationBytes = 4 * 1024 * 1024;

        private readonly BusinessContext db;

        public SystemOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public bool IsDatabaseConnectionExists() =>
            IsDatabaseConnectionExistsAsync().GetAwaiter().GetResult();

        public async Task<bool> IsDatabaseConnectionExistsAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return await db.Database.CanConnectAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch
            {
                return false;
            }
        }

        public ServiceResult CreateConfigurationServices(string appConfigurationFilePath) =>
            CreateConfigurationServicesAsync(appConfigurationFilePath).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateConfigurationServicesAsync(
            string appConfigurationFilePath,
            CancellationToken cancellationToken = default)
        {
            try
            {
                var pathResult = ValidateReadableFile(appConfigurationFilePath, MaxConfigurationFileBytes);
                if (!pathResult.IsSuccess)
                {
                    return pathResult;
                }

                var services = await ReadConfigurationServicesAsync(appConfigurationFilePath, cancellationToken);
                if (services.Count == 0)
                {
                    return Error("Konfigürasyon dosyasında geçerli servis bulunamadı.");
                }

                foreach (var service in services)
                {
                    service.SetCreate(-1);
                }

                cancellationToken.ThrowIfCancellationRequested();
                var existingServices = await db.GisConfigServices
                    .Where(x => x.Id > 0)
                    .ToListAsync(cancellationToken);

                db.GisConfigServices.RemoveRange(existingServices);
                await db.GisConfigServices.AddRangeAsync(services, cancellationToken);
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                return Error("Konfigürasyon oluşturulurken hata oluştu: " + ex.Message);
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult CreateMapConfiguration(string configFilePath) =>
            CreateMapConfigurationAsync(configFilePath).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateMapConfigurationAsync(
            string configFilePath,
            CancellationToken cancellationToken = default)
        {
            try
            {
                var pathResult = ValidateReadableFile(configFilePath, MaxMapConfigurationBytes);
                if (!pathResult.IsSuccess)
                {
                    return pathResult;
                }

                cancellationToken.ThrowIfCancellationRequested();
                var json = await File.ReadAllTextAsync(configFilePath, cancellationToken);
                if (string.IsNullOrWhiteSpace(json))
                {
                    return Error("Harita konfigürasyon dosyası boş olamaz.");
                }

                var config = new AppConfig
                {
                    ConfigKey = Configuration.ConfigKey_GisMapConfig,
                    ConfigValue = json
                };
                config.SetCreate(-1);

                var oldConfigs = await db.AppConfigs
                    .Where(x => x.ConfigKey == Configuration.ConfigKey_GisMapConfig)
                    .ToListAsync(cancellationToken);

                if (oldConfigs.Count > 0)
                {
                    db.AppConfigs.RemoveRange(oldConfigs);
                }

                await db.AppConfigs.AddAsync(config, cancellationToken);
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                return Error("Harita konfigürasyonu oluşturulurken hata oluştu: " + ex.Message);
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        private static async Task<List<GisConfigService>> ReadConfigurationServicesAsync(
            string path,
            CancellationToken cancellationToken)
        {
            var services = new List<GisConfigService>();
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true);
            using var reader = new StreamReader(stream);

            while (!reader.EndOfStream)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var line = await reader.ReadLineAsync(cancellationToken);
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                if (services.Count >= MaxConfigurationServices)
                {
                    throw new InvalidDataException($"Konfigürasyon en fazla {MaxConfigurationServices} servis içerebilir.");
                }

                var values = ParseCsvLine(line);
                if (values.Count != 4)
                {
                    throw new InvalidDataException("Her servis satırı category,title,url,description alanlarını içermelidir.");
                }

                var category = NormalizeRequired(values[0], MaxCategoryLength, "Kategori");
                var title = NormalizeRequired(values[1], MaxTitleLength, "Başlık");
                var url = NormalizeRequired(values[2], MaxUrlLength, "URL");
                var description = NormalizeOptional(values[3], MaxDescriptionLength, "Açıklama");

                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                    (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                {
                    throw new InvalidDataException("Servis URL alanı yalnız HTTP(S) absolute URL olabilir.");
                }

                services.Add(new GisConfigService
                {
                    Category = category,
                    Title = title,
                    Url = uri.AbsoluteUri,
                    Description = description,
                    RequiresSC = false
                });
            }

            return services;
        }

        private static List<string> ParseCsvLine(string line)
        {
            var values = new List<string>();
            var current = new System.Text.StringBuilder();
            var quoted = false;

            for (var index = 0; index < line.Length; index++)
            {
                var character = line[index];
                if (character == '"')
                {
                    if (quoted && index + 1 < line.Length && line[index + 1] == '"')
                    {
                        current.Append('"');
                        index++;
                    }
                    else
                    {
                        quoted = !quoted;
                    }
                    continue;
                }

                if (character == ',' && !quoted)
                {
                    values.Add(current.ToString());
                    current.Clear();
                    continue;
                }

                current.Append(character);
            }

            if (quoted)
            {
                throw new InvalidDataException("Konfigürasyon satırında kapatılmamış CSV tırnağı var.");
            }

            values.Add(current.ToString());
            return values;
        }

        private static ServiceResult ValidateReadableFile(string path, int maxBytes)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return Error("Konfigürasyon dosya yolu boş olamaz.");
            }

            var file = new FileInfo(path);
            if (!file.Exists)
            {
                return Error("Konfigürasyon dosyası bulunamadı.");
            }

            if (file.Length <= 0 || file.Length > maxBytes)
            {
                return Error($"Konfigürasyon dosyası 1 ile {maxBytes} byte arasında olmalıdır.");
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        private static string NormalizeRequired(string value, int maxLength, string field)
        {
            var normalized = value?.Trim();
            if (string.IsNullOrWhiteSpace(normalized))
            {
                throw new InvalidDataException(field + " boş olamaz.");
            }

            if (normalized.Length > maxLength)
            {
                throw new InvalidDataException($"{field} en fazla {maxLength} karakter olabilir.");
            }

            return normalized;
        }

        private static string NormalizeOptional(string value, int maxLength, string field)
        {
            var normalized = value?.Trim() ?? string.Empty;
            if (normalized.Length > maxLength)
            {
                throw new InvalidDataException($"{field} en fazla {maxLength} karakter olabilir.");
            }

            return normalized;
        }

        private static ServiceResult Error(string message) =>
            new ServiceResult(ServiceResultType.Error, message);
    }
}
