using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;
using Microsoft.EntityFrameworkCore;
using Toolbox.Security.Url;
using Toolbox.Validation;

namespace Business.Extensions.Gis.Operations
{
    public class GisConfigServiceOperations : _BaseOperations
    {
        private const int MaxTitleLength = 256;
        private const int MaxCategoryLength = 256;
        private const int MaxUrlLength = 2048;
        private const int MaxDescriptionLength = 4096;
        private const int MaxCredentialLength = 1024;
        private const int MaxIdentifyLayersLength = 2048;
        private const int MaxSearchCategoryLength = 256;
        private const int MaxImportRows = 2000;
        private const int MaxImportLineLength = 16384;

        private readonly BusinessContext db;

        public GisConfigServiceOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public ServiceResult<List<GisServiceViewModel>> GetConfigurationServices() =>
            GetConfigurationServicesAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisServiceViewModel>>> GetConfigurationServicesAsync(
            CancellationToken cancellationToken = default)
        {
            var list = await db.GisConfigServices
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .OrderBy(x => x.Title)
                .ThenBy(x => x.Id)
                .Select(x => new GisServiceViewModel { Title = x.Title, Url = x.Url })
                .ToListAsync(cancellationToken);

            return new ServiceResult<List<GisServiceViewModel>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisConfigService>> GetAll() => GetAllAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisConfigService>>> GetAllAsync(CancellationToken cancellationToken = default)
        {
            var list = await db.GisConfigServices
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .OrderBy(x => x.Category)
                .ThenBy(x => x.Title)
                .ThenBy(x => x.Id)
                .ToListAsync(cancellationToken);

            return new ServiceResult<List<GisConfigService>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisConfigurationServiceUserViewModel>> GetAllForPublic() =>
            GetAllForPublicAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisConfigurationServiceUserViewModel>>> GetAllForPublicAsync(
            CancellationToken cancellationToken = default)
        {
            var rows = await db.GisConfigServices
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .OrderBy(x => x.Category)
                .ThenBy(x => x.Title)
                .ThenBy(x => x.Id)
                .Select(x => new
                {
                    x.Title,
                    x.IsIdentifiable,
                    x.IdentifyLayers,
                    x.ShowInSearch,
                    x.SearchCategoryTitle,
                    x.Guid
                })
                .ToListAsync(cancellationToken);

            var list = rows.Select(x => new GisConfigurationServiceUserViewModel
            {
                Title = x.Title,
                IsIdentifiable = x.IsIdentifiable,
                IdentifyLayers = x.IdentifyLayers,
                ShowInSearch = x.ShowInSearch,
                SearchCategoryTitle = x.SearchCategoryTitle,
                Eg = "https://" + ParameterEncryptionUtils.EncryptGuid(x.Guid) + ".gissrv.org"
            }).ToList();

            return new ServiceResult<List<GisConfigurationServiceUserViewModel>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisConfigServiceGroup>> GetAllGrouped() =>
            GetAllGroupedAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisConfigServiceGroup>>> GetAllGroupedAsync(
            CancellationToken cancellationToken = default)
        {
            var list = await db.GisConfigServices
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .OrderBy(x => x.Category)
                .ThenBy(x => x.Title)
                .ThenBy(x => x.Id)
                .ToListAsync(cancellationToken);

            var grouped = list
                .GroupBy(x => x.Category)
                .Select(group => new GisConfigServiceGroup
                {
                    GroupTitle = group.Key,
                    Services = group.ToList()
                })
                .ToList();

            return new ServiceResult<List<GisConfigServiceGroup>>(ServiceResultType.Success, string.Empty, grouped);
        }

        public ServiceResult<GisConfigService> GetByEncryptedGuid(string eg) =>
            GetByEncryptedGuidAsync(eg).GetAwaiter().GetResult();

        public async Task<ServiceResult<GisConfigService>> GetByEncryptedGuidAsync(
            string eg,
            CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(eg))
            {
                return new ServiceResult<GisConfigService>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null);
            }

            Guid guid;
            try
            {
                guid = ParameterEncryptionUtils.DecryptGuid(eg.Trim());
            }
            catch
            {
                return new ServiceResult<GisConfigService>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null);
            }

            var model = await GetServiceByGuidAsync(guid, cancellationToken);
            return new ServiceResult<GisConfigService>(ServiceResultType.Success, string.Empty, model);
        }

        private Task<GisConfigService> GetServiceByGuidAsync(Guid guid, CancellationToken cancellationToken) =>
            db.GisConfigServices
                .AsNoTracking()
                .FirstOrDefaultAsync(x => x.Guid == guid.ToString() && !x.IsDeleted, cancellationToken);

        public GisConfigService GetServiceByUrl(string url) =>
            GetServiceByUrlAsync(url).GetAwaiter().GetResult();

        public async Task<GisConfigService> GetServiceByUrlAsync(
            string url,
            CancellationToken cancellationToken = default)
        {
            var normalizedUrl = NormalizeUrl(url);
            if (normalizedUrl == null)
            {
                return null;
            }

            var candidates = await db.GisConfigServices
                .AsNoTracking()
                .Where(x => !x.IsDeleted && x.Url != null)
                .ToListAsync(cancellationToken);

            return candidates.FirstOrDefault(x =>
                string.Equals(NormalizeUrl(x.Url), normalizedUrl, StringComparison.OrdinalIgnoreCase));
        }

        public ServiceResult Update(GisConfigService viewModel, UserSessionViewModel session) =>
            UpdateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> UpdateAsync(
            GisConfigService viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            var normalized = NormalizeAndValidate(viewModel);
            if (!normalized.IsSuccess)
            {
                return normalized.Result;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var model = await db.GisConfigServices
                .FirstOrDefaultAsync(x => x.Id == viewModel.Id && !x.IsDeleted, cancellationToken);
            if (model == null)
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
            }

            if (await HasDuplicateUrlAsync(normalized.Url, model.Id, cancellationToken))
            {
                return new ServiceResult(ServiceResultType.Error, "Aynı servis adresi zaten kayıtlı");
            }

            ApplyNormalized(model, viewModel, normalized);
            await db.SaveChangesAsync(cancellationToken);
            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPDATED"));
        }

        public ServiceResult Create(GisConfigService viewModel, UserSessionViewModel session) =>
            CreateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateAsync(
            GisConfigService viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            var normalized = NormalizeAndValidate(viewModel);
            if (!normalized.IsSuccess)
            {
                return normalized.Result;
            }

            cancellationToken.ThrowIfCancellationRequested();
            if (await HasDuplicateUrlAsync(normalized.Url, null, cancellationToken))
            {
                return new ServiceResult(ServiceResultType.Error, "Aynı servis adresi zaten kayıtlı");
            }

            ApplyNormalized(viewModel, viewModel, normalized);
            viewModel.SetCreate(session.UserId);
            await db.GisConfigServices.AddAsync(viewModel, cancellationToken);
            await db.SaveChangesAsync(cancellationToken);
            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("SAVED"));
        }

        public ServiceResult Delete(GisConfigService service, UserSessionViewModel session) =>
            DeleteAsync(service, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> DeleteAsync(
            GisConfigService service,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            if (service == null || service.Id <= 0)
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
            }

            cancellationToken.ThrowIfCancellationRequested();
            var model = await db.GisConfigServices
                .FirstOrDefaultAsync(x => x.Id == service.Id && !x.IsDeleted, cancellationToken);
            if (model == null)
            {
                return new ServiceResult(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"));
            }

            model.SetDelete(session.UserId);
            await db.SaveChangesAsync(cancellationToken);
            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("DELETED"));
        }

        public ServiceResult Import(string fileName, Stream stream, UserSessionViewModel session) =>
            ImportAsync(fileName, stream, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> ImportAsync(
            string fileName,
            Stream stream,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            if (stream == null || !stream.CanRead)
            {
                return new ServiceResult(ServiceResultType.Error, "Geçerli bir konfigürasyon dosyası gerekiyor");
            }

            var services = new List<GisConfigService>();
            var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using var reader = new StreamReader(stream, leaveOpen: true);

            string line;
            var rowNumber = 0;
            while ((line = await reader.ReadLineAsync(cancellationToken)) != null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                rowNumber++;
                if (rowNumber > MaxImportRows)
                {
                    return new ServiceResult(ServiceResultType.Error, $"En fazla {MaxImportRows} servis içe aktarılabilir");
                }
                if (line.Length > MaxImportLineLength)
                {
                    return new ServiceResult(ServiceResultType.Error, $"{rowNumber}. satır izin verilen boyutu aşıyor");
                }
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                if (!TryParseCsvLine(line, out var values) || values.Count != 11)
                {
                    return new ServiceResult(ServiceResultType.Error, $"{rowNumber}. satır geçerli 11 alanlı CSV biçiminde değil");
                }

                var candidate = new GisConfigService
                {
                    Category = values[0],
                    Title = values[1],
                    Url = values[2],
                    Description = values[3],
                    RequiresSC = IsTrue(values[4]),
                    SCUserName = values[5],
                    SCPassword = values[6],
                    IsIdentifiable = IsTrue(values[7]),
                    IdentifyLayers = values[8],
                    ShowInSearch = IsTrue(values[9]),
                    SearchCategoryTitle = values[10]
                };

                var normalized = NormalizeAndValidate(candidate);
                if (!normalized.IsSuccess)
                {
                    return new ServiceResult(ServiceResultType.Error, $"{rowNumber}. satır: {normalized.Result.Message}");
                }
                if (!seenUrls.Add(normalized.Url))
                {
                    return new ServiceResult(ServiceResultType.Error, $"{rowNumber}. satır: yinelenen servis adresi");
                }

                ApplyNormalized(candidate, candidate, normalized);
                candidate.SetCreate(session.UserId);
                services.Add(candidate);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var existing = await db.GisConfigServices.ToListAsync(cancellationToken);
            db.GisConfigServices.RemoveRange(existing);
            await db.GisConfigServices.AddRangeAsync(services, cancellationToken);
            await db.SaveChangesAsync(cancellationToken);
            return new ServiceResult(ServiceResultType.Success, BusinessMessages.Get("UPLOADED"));
        }

        private async Task<bool> HasDuplicateUrlAsync(string normalizedUrl, int? excludedId, CancellationToken cancellationToken)
        {
            var candidates = await db.GisConfigServices
                .AsNoTracking()
                .Where(x => !x.IsDeleted && x.Url != null && (!excludedId.HasValue || x.Id != excludedId.Value))
                .Select(x => x.Url)
                .ToListAsync(cancellationToken);

            return candidates.Any(x => string.Equals(NormalizeUrl(x), normalizedUrl, StringComparison.OrdinalIgnoreCase));
        }

        private static ValidationOutcome NormalizeAndValidate(GisConfigService viewModel)
        {
            if (viewModel == null)
            {
                return ValidationOutcome.Error("Servis bilgisi gerekiyor");
            }

            var title = NormalizeRequired(viewModel.Title, MaxTitleLength);
            if (title == null) return ValidationOutcome.Error("Servis adı boş olamaz veya çok uzun");
            var category = NormalizeRequired(viewModel.Category, MaxCategoryLength);
            if (category == null) return ValidationOutcome.Error("Kategori boş olamaz veya çok uzun");
            var url = NormalizeUrl(viewModel.Url);
            if (url == null) return ValidationOutcome.Error("Servis adresi geçerli bir HTTP/HTTPS adresi olmalıdır");
            var description = NormalizeOptional(viewModel.Description, MaxDescriptionLength);
            if (description == null && !string.IsNullOrWhiteSpace(viewModel.Description)) return ValidationOutcome.Error("Açıklama çok uzun");

            var userName = NormalizeOptional(viewModel.SCUserName, MaxCredentialLength);
            var password = NormalizeOptional(viewModel.SCPassword, MaxCredentialLength);
            if (viewModel.RequiresSC && (string.IsNullOrWhiteSpace(userName) || string.IsNullOrWhiteSpace(password)))
                return ValidationOutcome.Error("Güvenli bağlantı için kullanıcı adı ve şifre gerekiyor");

            var identifyLayers = NormalizeOptional(viewModel.IdentifyLayers, MaxIdentifyLayersLength);
            if (viewModel.IsIdentifiable && string.IsNullOrWhiteSpace(identifyLayers))
                return ValidationOutcome.Error("Bilgi alınabilir katman numaraları gerekiyor");

            var searchCategory = NormalizeOptional(viewModel.SearchCategoryTitle, MaxSearchCategoryLength);
            if (viewModel.ShowInSearch && string.IsNullOrWhiteSpace(searchCategory))
                return ValidationOutcome.Error("Arama kategorisi için başlık gerekiyor");

            return ValidationOutcome.Success(title, category, url, description, userName, password, identifyLayers, searchCategory);
        }

        private static void ApplyNormalized(GisConfigService target, GisConfigService source, ValidationOutcome normalized)
        {
            target.Title = normalized.Title;
            target.Category = normalized.Category;
            target.Url = normalized.Url;
            target.Description = normalized.Description ?? string.Empty;
            target.RequiresSC = source.RequiresSC;
            target.SCUserName = source.RequiresSC ? normalized.UserName : string.Empty;
            target.SCPassword = source.RequiresSC ? normalized.Password : string.Empty;
            target.IsIdentifiable = source.IsIdentifiable;
            target.IdentifyLayers = source.IsIdentifiable ? normalized.IdentifyLayers : string.Empty;
            target.ShowInSearch = source.ShowInSearch;
            target.SearchCategoryTitle = source.ShowInSearch ? normalized.SearchCategory : string.Empty;
        }

        private static string NormalizeUrl(string value)
        {
            var trimmed = value?.Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed.Length > MaxUrlLength || !ValidationUtils.ValidateUrl(trimmed))
                return null;
            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
                string.IsNullOrWhiteSpace(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo))
                return null;

            var builder = new UriBuilder(uri) { Fragment = string.Empty };
            var normalized = builder.Uri.AbsoluteUri.TrimEnd('/');
            return normalized.Length <= MaxUrlLength ? normalized : null;
        }

        private static string NormalizeRequired(string value, int maxLength)
        {
            var normalized = value?.Trim();
            return string.IsNullOrWhiteSpace(normalized) || normalized.Length > maxLength ? null : normalized;
        }

        private static string NormalizeOptional(string value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            var normalized = value.Trim();
            return normalized.Length > maxLength ? null : normalized;
        }

        private static bool IsTrue(string value) => string.Equals(value?.Trim(), "true", StringComparison.OrdinalIgnoreCase);

        private static bool TryParseCsvLine(string line, out List<string> values)
        {
            values = new List<string>();
            var current = new System.Text.StringBuilder();
            var quoted = false;
            for (var i = 0; i < line.Length; i++)
            {
                var c = line[i];
                if (c == '"')
                {
                    if (quoted && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        current.Append('"');
                        i++;
                    }
                    else
                    {
                        quoted = !quoted;
                    }
                }
                else if (c == ',' && !quoted)
                {
                    values.Add(current.ToString());
                    current.Clear();
                }
                else
                {
                    current.Append(c);
                }
            }
            if (quoted) return false;
            values.Add(current.ToString());
            return true;
        }

        private sealed class ValidationOutcome
        {
            public bool IsSuccess { get; private set; }
            public ServiceResult Result { get; private set; }
            public string Title { get; private set; }
            public string Category { get; private set; }
            public string Url { get; private set; }
            public string Description { get; private set; }
            public string UserName { get; private set; }
            public string Password { get; private set; }
            public string IdentifyLayers { get; private set; }
            public string SearchCategory { get; private set; }

            public static ValidationOutcome Error(string message) => new ValidationOutcome
            {
                IsSuccess = false,
                Result = new ServiceResult(ServiceResultType.Error, message)
            };

            public static ValidationOutcome Success(string title, string category, string url, string description,
                string userName, string password, string identifyLayers, string searchCategory) => new ValidationOutcome
            {
                IsSuccess = true,
                Result = new ServiceResult(ServiceResultType.Success),
                Title = title,
                Category = category,
                Url = url,
                Description = description,
                UserName = userName,
                Password = password,
                IdentifyLayers = identifyLayers,
                SearchCategory = searchCategory
            };
        }
    }
}
