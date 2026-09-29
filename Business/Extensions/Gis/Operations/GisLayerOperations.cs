using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Toolbox.Security.Url;
using Toolbox.Serialization;
using Toolbox.Text;
using Toolbox.Validation;
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
        private const int MaxTitleLength = 256;
        private const int MaxUrlLength = 4096;
        private const int MaxDescriptionLength = 4096;
        private const int MaxAdditionalInfoLength = 16384;
        private const int MaxCredentialLength = 1024;
        private const int MaxReorderItems = 5000;

        private readonly BusinessContext db;

        public GisLayerOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public ServiceResult Create(GisLayerAdminViewModel viewModel, UserSessionViewModel session) =>
            CreateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateAsync(
            GisLayerAdminViewModel viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var validation = ValidateAndNormalize(viewModel);
            if (!validation.IsSuccess)
            {
                return validation;
            }

            if (session == null)
            {
                return Error("Geçerli kullanıcı oturumu gerekiyor");
            }

            if (await HasDuplicateUrlAsync(viewModel.Url, null, cancellationToken))
            {
                return Error("Aynı bağlantı adresine sahip aktif bir katman zaten var");
            }

            var model = new GisLayer();
            ApplyMutableFields(model, viewModel);
            model.SetCreate(session.UserId);
            await db.GisLayers.AddAsync(model, cancellationToken);
            await db.SaveChangesAsync(cancellationToken);
            return Success(BusinessMessages.Get("SAVED"));
        }

        public ServiceResult Update(GisLayerAdminViewModel viewModel, UserSessionViewModel session) =>
            UpdateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> UpdateAsync(
            GisLayerAdminViewModel viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (viewModel == null || viewModel.Id <= 0)
            {
                return Error(BusinessMessages.Get("NOT_FOUND"));
            }

            var validation = ValidateAndNormalize(viewModel);
            if (!validation.IsSuccess)
            {
                return validation;
            }

            if (session == null)
            {
                return Error("Geçerli kullanıcı oturumu gerekiyor");
            }

            var model = await db.GisLayers
                .FirstOrDefaultAsync(x => x.Id == viewModel.Id && !x.IsDeleted, cancellationToken);
            if (model == null)
            {
                return Error(BusinessMessages.Get("NOT_FOUND"));
            }

            if (await HasDuplicateUrlAsync(viewModel.Url, model.Id, cancellationToken))
            {
                return Error("Aynı bağlantı adresine sahip aktif bir katman zaten var");
            }

            ApplyMutableFields(model, viewModel);
            model.SetUpdate(session.UserId);
            await db.SaveChangesAsync(cancellationToken);
            return Success(BusinessMessages.Get("UPDATED"));
        }

        public ServiceResult Delete(int id, UserSessionViewModel session) =>
            DeleteAsync(id, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> DeleteAsync(
            int id,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (id <= 0 || session == null)
            {
                return Error(BusinessMessages.Get("NOT_FOUND"));
            }

            var layer = await db.GisLayers
                .FirstOrDefaultAsync(x => x.Id == id && !x.IsDeleted, cancellationToken);
            if (layer == null)
            {
                return Error(BusinessMessages.Get("NOT_FOUND"));
            }

            layer.SetDelete(session.UserId);
            await db.SaveChangesAsync(cancellationToken);
            return Success(BusinessMessages.Get("DELETED"));
        }

        public ServiceResult<List<GisLayer>> GetAll() =>
            GetAllAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisLayer>>> GetAllAsync(CancellationToken cancellationToken = default)
        {
            var list = await db.GisLayers
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .Include(x => x.LayerGroup)
                .OrderBy(x => x.OrderPriority)
                .ThenBy(x => x.Title)
                .ThenBy(x => x.Id)
                .ToListAsync(cancellationToken);
            return new ServiceResult<List<GisLayer>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisLayer>> GetUngroupedLayers() =>
            GetUngroupedLayersAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisLayer>>> GetUngroupedLayersAsync(CancellationToken cancellationToken = default)
        {
            var list = await db.GisLayers
                .AsNoTracking()
                .Where(x => !x.IsDeleted && x.GisLayerGroupId == -1)
                .OrderBy(x => x.OrderPriority)
                .ThenBy(x => x.Title)
                .ThenBy(x => x.Id)
                .ToListAsync(cancellationToken);
            return new ServiceResult<List<GisLayer>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisLayerGroup>> GetLayerGroups() =>
            GetLayerGroupsAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisLayerGroup>>> GetLayerGroupsAsync(CancellationToken cancellationToken = default)
        {
            var list = await db.GisLayerGroups
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .Include(x => x.Layers)
                .OrderBy(x => x.OrderPriority)
                .ThenBy(x => x.Title)
                .ThenBy(x => x.Id)
                .ToListAsync(cancellationToken);
            return new ServiceResult<List<GisLayerGroup>>(ServiceResultType.Success, string.Empty, list);
        }

        public GisLayer GetLayerByGuid(string guid) =>
            GetLayerByGuidAsync(guid).GetAwaiter().GetResult();

        public async Task<GisLayer> GetLayerByGuidAsync(string guid, CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(guid))
            {
                return null;
            }

            var normalized = guid.Trim();
            return await db.GisLayers.AsNoTracking()
                .FirstOrDefaultAsync(x => x.Guid == normalized && !x.IsDeleted, cancellationToken);
        }

        public ServiceResult<GisLayer> GetByEncryptedGuid(string encryptedGuid) =>
            GetByEncryptedGuidAsync(encryptedGuid).GetAwaiter().GetResult();

        public async Task<ServiceResult<GisLayer>> GetByEncryptedGuidAsync(
            string encryptedGuid,
            CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(encryptedGuid) || encryptedGuid.Length > 4096)
            {
                return new ServiceResult<GisLayer>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null);
            }

            try
            {
                var guid = ParameterEncryptionUtils.DecryptGuid(encryptedGuid).ToString();
                var layer = await GetLayerByGuidAsync(guid, cancellationToken);
                return layer == null
                    ? new ServiceResult<GisLayer>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null)
                    : new ServiceResult<GisLayer>(ServiceResultType.Success, string.Empty, layer);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch
            {
                return new ServiceResult<GisLayer>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null);
            }
        }

        public GisLayer GetLayerByUrl(string url) =>
            GetLayerByUrlAsync(url).GetAwaiter().GetResult();

        public async Task<GisLayer> GetLayerByUrlAsync(string url, CancellationToken cancellationToken = default)
        {
            var normalized = NormalizeUrl(url);
            if (normalized == null)
            {
                return null;
            }

            var candidates = await db.GisLayers.AsNoTracking()
                .Where(x => !x.IsDeleted && x.Url != null)
                .ToListAsync(cancellationToken);
            return candidates.FirstOrDefault(x => string.Equals(
                NormalizeUrl(x.Url), normalized, StringComparison.OrdinalIgnoreCase));
        }

        public ServiceResult ReOrderGisLayers(string encryptedGuids) =>
            ReOrderGisLayersAsync(encryptedGuids).GetAwaiter().GetResult();

        public async Task<ServiceResult> ReOrderGisLayersAsync(
            string encryptedGuids,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(encryptedGuids) || encryptedGuids.Length > 1_000_000)
            {
                return Error("Geçersiz katman sıralaması");
            }

            List<string> encryptedGuidList;
            try
            {
                encryptedGuidList = SerializationUtils.JsonToObject<List<string>>(encryptedGuids);
            }
            catch
            {
                return Error("Geçersiz katman sıralaması");
            }

            if (encryptedGuidList == null || encryptedGuidList.Count == 0 || encryptedGuidList.Count > MaxReorderItems)
            {
                return Error("Geçersiz katman sıralaması");
            }

            var seen = new HashSet<int>();
            var layers = new List<GisLayer>(encryptedGuidList.Count);
            foreach (var encryptedGuid in encryptedGuidList)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var result = await GetByEncryptedGuidAsync(encryptedGuid, cancellationToken);
                if (!result.IsSuccess || result.Data == null || !seen.Add(result.Data.Id))
                {
                    return Error("Geçersiz veya yinelenen katman sıralaması");
                }

                var tracked = await db.GisLayers
                    .FirstOrDefaultAsync(x => x.Id == result.Data.Id && !x.IsDeleted, cancellationToken);
                if (tracked == null)
                {
                    return Error(BusinessMessages.Get("NOT_FOUND"));
                }
                layers.Add(tracked);
            }

            for (var index = 0; index < layers.Count; index++)
            {
                layers[index].OrderPriority = index + 1;
            }

            await db.SaveChangesAsync(cancellationToken);
            return Success("Katmanlar yeniden sıralandı");
        }

        private async Task<bool> HasDuplicateUrlAsync(string normalizedUrl, int? excludedId, CancellationToken cancellationToken)
        {
            var candidates = await db.GisLayers.AsNoTracking()
                .Where(x => !x.IsDeleted && x.Url != null && (!excludedId.HasValue || x.Id != excludedId.Value))
                .Select(x => x.Url)
                .ToListAsync(cancellationToken);
            return candidates.Any(x => string.Equals(
                NormalizeUrl(x), normalizedUrl, StringComparison.OrdinalIgnoreCase));
        }

        private static ServiceResult ValidateAndNormalize(GisLayerAdminViewModel viewModel)
        {
            if (viewModel == null)
            {
                return Error("Katman bilgisi boş olamaz");
            }

            viewModel.Title = NormalizeBounded(viewModel.Title, MaxTitleLength);
            if (viewModel.Title == null)
            {
                return Error("Katman adı boş olamaz veya çok uzun");
            }

            viewModel.Url = NormalizeUrl(viewModel.Url);
            if (viewModel.Url == null)
            {
                return Error(BusinessMessages.Get("INVALID_URL"));
            }

            viewModel.Description = NormalizeOptional(viewModel.Description, MaxDescriptionLength);
            viewModel.AdditionalInfo = NormalizeOptional(viewModel.AdditionalInfo, MaxAdditionalInfoLength);
            if (viewModel.Description == null || viewModel.AdditionalInfo == null)
            {
                return Error("Katman açıklaması veya ek bilgisi çok uzun");
            }

            if (viewModel.StartupOpacity < 0 || viewModel.StartupOpacity > 100)
            {
                return Error("Başlangıç saydamlığı 0 ile 100 arasında olmalıdır");
            }

            if (viewModel.OrderPriority < 0)
            {
                return Error("Katman sırası negatif olamaz");
            }

            if (viewModel.RequiresSC)
            {
                viewModel.SCUserName = NormalizeBounded(viewModel.SCUserName, MaxCredentialLength);
                viewModel.SCPassword = NormalizeBounded(viewModel.SCPassword, MaxCredentialLength);
                if (viewModel.SCUserName == null || viewModel.SCPassword == null)
                {
                    return Error("Güvenli bağlantı için geçerli kullanıcı adı ve şifre gerekiyor");
                }
            }
            else
            {
                viewModel.SCUserName = string.Empty;
                viewModel.SCPassword = string.Empty;
            }

            return Success();
        }

        private static void ApplyMutableFields(GisLayer model, GisLayerAdminViewModel viewModel)
        {
            model.RequiresSC = viewModel.RequiresSC;
            model.SCUserName = viewModel.SCUserName;
            model.SCPassword = viewModel.SCPassword;
            model.Url = viewModel.Url;
            model.AdditionalInfo = viewModel.AdditionalInfo;
            model.LayerType = viewModel.LayerType;
            model.GisLayerGroupId = viewModel.GisLayerGroupId;
            model.Title = TextUtils.Capitalize(viewModel.Title);
            model.OrderPriority = viewModel.OrderPriority;
            model.StartupOpacity = viewModel.StartupOpacity;
            model.VisibleAtStartup = viewModel.VisibleAtStartup;
            model.IsSwipeLayer = viewModel.IsSwipeLayer;
            model.IsTimelineLayer = viewModel.IsTimelineLayer;
            model.Description = viewModel.Description;
        }

        private static string NormalizeUrl(string value)
        {
            var normalized = NormalizeBounded(value, MaxUrlLength);
            if (normalized == null || !ValidationUtils.ValidateUrl(normalized) ||
                !Uri.TryCreate(normalized, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                return null;
            }

            var builder = new UriBuilder(uri) { Fragment = string.Empty };
            var canonical = builder.Uri.AbsoluteUri;
            return canonical.EndsWith("/", StringComparison.Ordinal) && builder.Path.Length > 1
                ? canonical.TrimEnd('/')
                : canonical;
        }

        private static string NormalizeBounded(string value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }
            var normalized = value.Trim();
            return normalized.Length <= maxLength ? normalized : null;
        }

        private static string NormalizeOptional(string value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }
            var normalized = value.Trim();
            return normalized.Length <= maxLength ? normalized : null;
        }

        private static ServiceResult Success(string message = "") =>
            new ServiceResult(ServiceResultType.Success, message);

        private static ServiceResult Error(string message) =>
            new ServiceResult(ServiceResultType.Error, message);
    }
}
