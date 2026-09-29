using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Toolbox.Security.Url;
using Toolbox.Serialization;
using Toolbox.Text;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;
using Microsoft.EntityFrameworkCore;

namespace Business.Extensions.Gis.Operations
{
    public class GisLayerGroupOperations : _BaseOperations
    {
        private const int MaxTitleLength = 256;
        private const int MaxReorderItems = 2000;
        private const int MaxReorderPayloadLength = 512_000;
        private static readonly CultureInfo TurkishCulture = CultureInfo.GetCultureInfo("tr-TR");
        private readonly BusinessContext db;

        public GisLayerGroupOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public ServiceResult ValidateCreate(GisLayerGroup viewModel) => ValidateAndNormalize(viewModel);
        public ServiceResult ValidateUpdate(GisLayerGroup viewModel) => ValidateAndNormalize(viewModel);

        public ServiceResult Create(GisLayerGroup viewModel, UserSessionViewModel session) => CreateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateAsync(GisLayerGroup viewModel, UserSessionViewModel session, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var validation = ValidateAndNormalize(viewModel);
            if (!validation.IsSuccess) return validation;
            if (session == null) return Error("Geçerli kullanıcı oturumu gerekiyor");
            if (await HasDuplicateTitleAsync(viewModel.Title, null, cancellationToken)) return Error("Aynı ada sahip aktif bir katman grubu zaten var");
            var model = new GisLayerGroup { Title = TextUtils.Capitalize(viewModel.Title), OrderPriority = Math.Max(0, viewModel.OrderPriority) };
            model.SetCreate(session.UserId);
            await db.GisLayerGroups.AddAsync(model, cancellationToken);
            await db.SaveChangesAsync(cancellationToken);
            return Success(BusinessMessages.Get("SAVED"));
        }

        public ServiceResult Update(GisLayerGroup viewModel, UserSessionViewModel session) => UpdateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> UpdateAsync(GisLayerGroup viewModel, UserSessionViewModel session, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (viewModel == null || viewModel.Id <= 0 || session == null) return Error(BusinessMessages.Get("NOT_FOUND"));
            var validation = ValidateAndNormalize(viewModel);
            if (!validation.IsSuccess) return validation;
            var model = await db.GisLayerGroups.FirstOrDefaultAsync(x => x.Id == viewModel.Id && !x.IsDeleted, cancellationToken);
            if (model == null) return Error(BusinessMessages.Get("NOT_FOUND"));
            if (await HasDuplicateTitleAsync(viewModel.Title, model.Id, cancellationToken)) return Error("Aynı ada sahip aktif bir katman grubu zaten var");
            model.Title = TextUtils.Capitalize(viewModel.Title);
            model.OrderPriority = Math.Max(0, viewModel.OrderPriority);
            model.SetUpdate(session.UserId);
            await db.SaveChangesAsync(cancellationToken);
            return Success(BusinessMessages.Get("UPDATED"));
        }

        public ServiceResult Delete(GisLayerGroup viewModel, UserSessionViewModel session) => DeleteAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> DeleteAsync(GisLayerGroup viewModel, UserSessionViewModel session, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (viewModel == null || viewModel.Id <= 0 || session == null) return Error(BusinessMessages.Get("NOT_FOUND"));
            var model = await db.GisLayerGroups.FirstOrDefaultAsync(x => x.Id == viewModel.Id && !x.IsDeleted, cancellationToken);
            if (model == null) return Error(BusinessMessages.Get("NOT_FOUND"));
            var layers = await db.GisLayers.Where(x => !x.IsDeleted && x.GisLayerGroupId == model.Id).ToListAsync(cancellationToken);
            foreach (var layer in layers) { layer.GisLayerGroupId = -1; layer.SetUpdate(session.UserId); }
            model.SetDelete(session.UserId);
            await db.SaveChangesAsync(cancellationToken);
            return Success(BusinessMessages.Get("DELETED"));
        }

        public ServiceResult ReorderItems(string encryptedGuids) => ReorderItemsAsync(encryptedGuids).GetAwaiter().GetResult();
        public async Task<ServiceResult> ReorderItemsAsync(string encryptedGuids, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(encryptedGuids) || encryptedGuids.Length > MaxReorderPayloadLength) return Error("Geçersiz katman grubu sıralaması");
            List<string> encryptedGuidList;
            try { encryptedGuidList = SerializationUtils.JsonToObject<List<string>>(encryptedGuids); } catch { return Error("Geçersiz katman grubu sıralaması"); }
            if (encryptedGuidList == null || encryptedGuidList.Count == 0 || encryptedGuidList.Count > MaxReorderItems) return Error("Geçersiz katman grubu sıralaması");
            var ids = new List<int>(encryptedGuidList.Count); var seen = new HashSet<int>();
            foreach (var encryptedGuid in encryptedGuidList)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var id = await ResolveEncryptedGroupIdAsync(encryptedGuid, cancellationToken);
                if (!id.HasValue || !seen.Add(id.Value)) return Error("Geçersiz veya yinelenen katman grubu sıralaması");
                ids.Add(id.Value);
            }
            var tracked = await db.GisLayerGroups.Where(x => !x.IsDeleted && ids.Contains(x.Id)).ToListAsync(cancellationToken);
            if (tracked.Count != ids.Count) return Error(BusinessMessages.Get("NOT_FOUND"));
            var byId = tracked.ToDictionary(x => x.Id);
            for (var index = 0; index < ids.Count; index++) byId[ids[index]].OrderPriority = index + 1;
            await db.SaveChangesAsync(cancellationToken);
            return Success("Katman grupları yeniden sıralandı");
        }

        public ServiceResult<List<GisLayerGroupAdminViewModel>> GetAll() => GetAllAsync().GetAwaiter().GetResult();
        public async Task<ServiceResult<List<GisLayerGroupAdminViewModel>>> GetAllAsync(CancellationToken cancellationToken = default)
        {
            var list = await db.GisLayerGroups.AsNoTracking().Where(x => !x.IsDeleted).OrderBy(x => x.OrderPriority).ThenBy(x => x.Title).ThenBy(x => x.Id).Select(x => new GisLayerGroupAdminViewModel { Id = x.Id, Title = x.Title }).ToListAsync(cancellationToken);
            return new ServiceResult<List<GisLayerGroupAdminViewModel>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisLayerGroupAdminViewModel>> GetAllWithLayersForAdmin() => GetAllWithLayersForAdminAsync().GetAwaiter().GetResult();
        public async Task<ServiceResult<List<GisLayerGroupAdminViewModel>>> GetAllWithLayersForAdminAsync(CancellationToken cancellationToken = default)
        {
            var groups = await db.GisLayerGroups.AsNoTracking().Where(x => !x.IsDeleted).OrderBy(x => x.OrderPriority).ThenBy(x => x.Title).ThenBy(x => x.Id).Select(x => new { x.Id, x.Title }).ToListAsync(cancellationToken);
            var groupIds = groups.Select(x => x.Id).ToArray();
            var layers = groupIds.Length == 0 ? new List<GisLayer>() : await db.GisLayers.AsNoTracking().Where(x => !x.IsDeleted && groupIds.Contains(x.GisLayerGroupId)).OrderBy(x => x.OrderPriority).ThenBy(x => x.Title).ThenBy(x => x.Id).ToListAsync(cancellationToken);
            var layersByGroup = layers.GroupBy(x => x.GisLayerGroupId).ToDictionary(x => x.Key, x => x.ToList());
            var result = groups.Select(group => new GisLayerGroupAdminViewModel { Id = group.Id, Title = group.Title, Layers = layersByGroup.TryGetValue(group.Id, out var groupLayers) ? groupLayers.Select(ToAdminLayer).ToList() : new List<GisLayerAdminViewModel>() }).ToList();
            return new ServiceResult<List<GisLayerGroupAdminViewModel>>(ServiceResultType.Success, string.Empty, result);
        }

        public ServiceResult<List<GisLayerGroupViewModel>> GetAllWithLayersForUser() => GetAllWithLayersForUserAsync().GetAwaiter().GetResult();
        public async Task<ServiceResult<List<GisLayerGroupViewModel>>> GetAllWithLayersForUserAsync(CancellationToken cancellationToken = default)
        {
            var groups = await db.GisLayerGroups.AsNoTracking().Where(x => !x.IsDeleted).OrderBy(x => x.OrderPriority).ThenBy(x => x.Title).ThenBy(x => x.Id).Select(x => new { x.Id, x.Title }).ToListAsync(cancellationToken);
            var groupIds = groups.Select(x => x.Id).ToArray();
            var layers = groupIds.Length == 0 ? new List<GisLayer>() : await db.GisLayers.AsNoTracking().Where(x => !x.IsDeleted && groupIds.Contains(x.GisLayerGroupId)).OrderBy(x => x.OrderPriority).ThenBy(x => x.Title).ThenBy(x => x.Id).ToListAsync(cancellationToken);
            var layersByGroup = layers.GroupBy(x => x.GisLayerGroupId).ToDictionary(x => x.Key, x => x.ToList());
            var result = groups.Select(group => new GisLayerGroupViewModel { Id = group.Id, Title = group.Title, Layers = layersByGroup.TryGetValue(group.Id, out var groupLayers) ? groupLayers.Select(ToUserLayer).ToList() : new List<GisLayerViewModel>() }).ToList();
            return new ServiceResult<List<GisLayerGroupViewModel>>(ServiceResultType.Success, string.Empty, result);
        }

        public ServiceResult<GisLayerGroup> GetByEncryptedGuid(string eg) => GetByEncryptedGuidAsync(eg).GetAwaiter().GetResult();
        public async Task<ServiceResult<GisLayerGroup>> GetByEncryptedGuidAsync(string eg, CancellationToken cancellationToken = default)
        {
            var id = await ResolveEncryptedGroupIdAsync(eg, cancellationToken);
            if (!id.HasValue) return new ServiceResult<GisLayerGroup>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null);
            var group = await db.GisLayerGroups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id.Value && !x.IsDeleted, cancellationToken);
            return group == null ? new ServiceResult<GisLayerGroup>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null) : new ServiceResult<GisLayerGroup>(ServiceResultType.Success, string.Empty, group);
        }

        private async Task<int?> ResolveEncryptedGroupIdAsync(string encryptedGuid, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(encryptedGuid) || encryptedGuid.Length > 4096) return null;
            Guid guid;
            try { guid = ParameterEncryptionUtils.DecryptGuid(encryptedGuid); } catch (OperationCanceledException) { throw; } catch { return null; }
            return await db.GisLayerGroups.AsNoTracking().Where(x => !x.IsDeleted && x.Guid == guid.ToString()).Select(x => (int?)x.Id).FirstOrDefaultAsync(cancellationToken);
        }

        private async Task<bool> HasDuplicateTitleAsync(string title, int? excludedId, CancellationToken cancellationToken)
        {
            var normalized = NormalizeTitleKey(title);
            var titles = await db.GisLayerGroups.AsNoTracking().Where(x => !x.IsDeleted && (!excludedId.HasValue || x.Id != excludedId.Value)).Select(x => x.Title).ToListAsync(cancellationToken);
            return titles.Any(x => string.Equals(NormalizeTitleKey(x), normalized, StringComparison.Ordinal));
        }

        private static string NormalizeTitleKey(string value) => (value ?? string.Empty).Trim().ToUpper(TurkishCulture);

        private static ServiceResult ValidateAndNormalize(GisLayerGroup viewModel)
        {
            if (viewModel == null) return Error("Katman grubu bilgisi boş olamaz");
            if (string.IsNullOrWhiteSpace(viewModel.Title)) return Error("Katman grubu adı boş olamaz");
            viewModel.Title = viewModel.Title.Trim();
            if (viewModel.Title.Length > MaxTitleLength) return Error("Katman grubu adı çok uzun");
            if (viewModel.OrderPriority < 0) return Error("Katman grubu sırası negatif olamaz");
            return Success();
        }

        private static GisLayerAdminViewModel ToAdminLayer(GisLayer x) => new GisLayerAdminViewModel { AdditionalInfo = x.AdditionalInfo, Description = x.Description, GisLayerGroupId = x.GisLayerGroupId, Id = x.Id, IsSwipeLayer = x.IsSwipeLayer, IsTimelineLayer = x.IsTimelineLayer, LayerType = x.LayerType, OrderPriority = x.OrderPriority, RequiresSC = x.RequiresSC, SCPassword = x.SCPassword, SCUserName = x.SCUserName, StartupOpacity = x.StartupOpacity, Title = x.Title, Url = x.Url, VisibleAtStartup = x.VisibleAtStartup };
        private static GisLayerViewModel ToUserLayer(GisLayer x) => new GisLayerViewModel { AdditionalInfo = x.AdditionalInfo, Description = x.Description, Id = x.Id, IsSwipeLayer = x.IsSwipeLayer, IsTimelineLayer = x.IsTimelineLayer, LayerType = x.LayerType, Priority = x.OrderPriority, Opacity = x.StartupOpacity, Title = x.Title, Visible = x.VisibleAtStartup, Eg = "https://" + ParameterEncryptionUtils.EncryptGuid(x.Guid) + ".gissrv.org" };
        private static ServiceResult Success(string message = "") => new ServiceResult(ServiceResultType.Success, message);
        private static ServiceResult Error(string message) => new ServiceResult(ServiceResultType.Error, message);
    }
}
