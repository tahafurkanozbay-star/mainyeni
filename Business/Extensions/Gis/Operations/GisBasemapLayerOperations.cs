using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Toolbox.Security.Url;
using Toolbox.Text;

namespace Business.Extensions.Gis.Operations
{
    public class GisBasemapLayerOperations : _BaseOperations
    {
        private const int MaxTitleLength = 256;
        private const int MaxUrlLength = 2048;
        private const int MaxDescriptionLength = 4096;
        private const int MaxCredentialLength = 512;

        private readonly BusinessContext db;

        public GisBasemapLayerOperations(BusinessContext dbContext)
        {
            db = dbContext ?? throw new ArgumentNullException(nameof(dbContext));
        }

        public ServiceResult Create(GisBasemapLayer layer, UserSessionViewModel session) =>
            CreateAsync(layer, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateAsync(
            GisBasemapLayer layer,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var validation = NormalizeAndValidate(layer, requireId: false);
            if (!validation.IsSuccess) return validation;
            if (session == null) return Error("Oturum bilgisi gerekli");

            layer.SetCreate(session.UserId);
            await db.GisBasemapLayers.AddAsync(layer, cancellationToken).ConfigureAwait(false);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return Success("SAVED");
        }

        public ServiceResult Update(GisBasemapLayer viewModel, UserSessionViewModel session) =>
            UpdateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> UpdateAsync(
            GisBasemapLayer viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var validation = NormalizeAndValidate(viewModel, requireId: true);
            if (!validation.IsSuccess) return validation;
            if (session == null) return Error("Oturum bilgisi gerekli");

            var model = await db.GisBasemapLayers
                .FirstOrDefaultAsync(x => x.Id == viewModel.Id && !x.IsDeleted, cancellationToken)
                .ConfigureAwait(false);
            if (model == null) return Error(BusinessMessages.Get("NOT_FOUND"), translate: false);

            model.Title = viewModel.Title;
            model.Url = viewModel.Url;
            model.Description = viewModel.Description;
            model.ImageUrl = NormalizeOptional(viewModel.ImageUrl);
            model.RequiresSC = viewModel.RequiresSC;
            model.SCUserName = viewModel.RequiresSC ? viewModel.SCUserName : string.Empty;
            model.SCPassword = viewModel.RequiresSC ? viewModel.SCPassword : string.Empty;
            model.SetUpdate(session.UserId);

            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return Success("UPDATED");
        }

        public ServiceResult Delete(int id, UserSessionViewModel session) =>
            DeleteAsync(id, session).GetAwaiter().GetResult();

        public async Task<ServiceResult> DeleteAsync(
            int id,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (id <= 0) return Error(BusinessMessages.Get("NOT_FOUND"), translate: false);
            if (session == null) return Error("Oturum bilgisi gerekli");

            var layer = await db.GisBasemapLayers
                .FirstOrDefaultAsync(x => x.Id == id && !x.IsDeleted, cancellationToken)
                .ConfigureAwait(false);
            if (layer == null) return Error(BusinessMessages.Get("NOT_FOUND"), translate: false);

            layer.SetDelete(session.UserId);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return Success("DELETED");
        }

        public ServiceResult<GisBasemapLayer> GetByEncryptedGuid(string eg)
        {
            var guid = ParameterEncryptionUtils.DecryptGuid(eg).ToString();
            var layer = GetByGuidAsync(guid).GetAwaiter().GetResult();
            return new ServiceResult<GisBasemapLayer>(ServiceResultType.Success, string.Empty, layer);
        }

        public GisBasemapLayer getByGuid(string guid) => GetByGuidAsync(guid).GetAwaiter().GetResult();

        public async Task<GisBasemapLayer> GetByGuidAsync(
            string guid,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var normalized = NormalizeOptional(guid);
            if (string.IsNullOrEmpty(normalized)) return null;

            return await db.GisBasemapLayers
                .AsNoTracking()
                .FirstOrDefaultAsync(x => x.Guid == normalized && !x.IsDeleted, cancellationToken)
                .ConfigureAwait(false);
        }

        public ServiceResult<List<GisBasemapLayer>> GetAll() =>
            GetAllAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisBasemapLayer>>> GetAllAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var list = await db.GisBasemapLayers
                .AsNoTracking()
                .Where(x => !x.IsDeleted)
                .OrderBy(x => x.Title)
                .ThenBy(x => x.Id)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            return new ServiceResult<List<GisBasemapLayer>>(ServiceResultType.Success, string.Empty, list);
        }

        public ServiceResult<List<GisBasemapLayerViewModel>> GetAllWithBuiltinBasemapList() =>
            GetAllWithBuiltinBasemapListAsync().GetAwaiter().GetResult();

        public async Task<ServiceResult<List<GisBasemapLayerViewModel>>> GetAllWithBuiltinBasemapListAsync(
            CancellationToken cancellationToken = default)
        {
            var layerResult = await GetAllAsync(cancellationToken).ConfigureAwait(false);
            if (!layerResult.IsSuccess)
            {
                return new ServiceResult<List<GisBasemapLayerViewModel>>(
                    ServiceResultType.Error,
                    "Liste getirilirken bir hata oluştu",
                    null);
            }

            var list = layerResult.Data.Select(x => new GisBasemapLayerViewModel
            {
                Id = x.Id,
                Title = x.Title,
                Url = x.Url,
                ThumbnailUrl = x.ImageUrl
            }).ToList();

            foreach (var title in BuiltinBasemaps)
            {
                list.Add(new GisBasemapLayerViewModel { Title = title });
            }

            return new ServiceResult<List<GisBasemapLayerViewModel>>(ServiceResultType.Success, string.Empty, list);
        }

        public GisBasemapLayer GetLayerByUrl(string url) =>
            GetLayerByUrlAsync(url).GetAwaiter().GetResult();

        public async Task<GisBasemapLayer> GetLayerByUrlAsync(
            string url,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var normalized = NormalizeOptional(url);
            if (string.IsNullOrEmpty(normalized) || normalized.Length > MaxUrlLength) return null;

            // URL identity should be deterministic. The legacy bidirectional Contains comparison
            // allowed unrelated parent/child URLs to alias one another and forced broad string work.
            return await db.GisBasemapLayers
                .AsNoTracking()
                .FirstOrDefaultAsync(x => !x.IsDeleted && x.Url == normalized, cancellationToken)
                .ConfigureAwait(false);
        }

        private static ServiceResult NormalizeAndValidate(GisBasemapLayer layer, bool requireId)
        {
            if (layer == null) return Error("Katman bilgisi gerekli");
            if (requireId && layer.Id <= 0) return Error(BusinessMessages.Get("NOT_FOUND"), translate: false);

            layer.Title = NormalizeOptional(layer.Title);
            layer.Url = NormalizeOptional(layer.Url);
            layer.Description = NormalizeOptional(layer.Description);
            layer.ImageUrl = NormalizeOptional(layer.ImageUrl);

            if (string.IsNullOrWhiteSpace(layer.Title)) return Error("Katman adı boş olamaz");
            if (layer.Title.Length > MaxTitleLength) return Error("Katman adı çok uzun");
            if (string.IsNullOrWhiteSpace(layer.Url)) return Error("Katman adresi boş olamaz");
            if (layer.Url.Length > MaxUrlLength || !ValidationUtils.ValidateUrl(layer.Url))
                return Error(BusinessMessages.Get("INVALID_URL"), translate: false);

            layer.Title = TextUtils.Capitalize(layer.Title);
            if (layer.Description?.Length > MaxDescriptionLength) return Error("Katman açıklaması çok uzun");

            if (!layer.RequiresSC)
            {
                layer.SCUserName = string.Empty;
                layer.SCPassword = string.Empty;
                return new ServiceResult(ServiceResultType.Success);
            }

            layer.SCUserName = NormalizeOptional(layer.SCUserName);
            layer.SCPassword = NormalizeOptional(layer.SCPassword);
            if (string.IsNullOrWhiteSpace(layer.SCUserName))
                return Error("Güvenli Bağlantı için bir kullanıcı adı gerekiyor");
            if (string.IsNullOrWhiteSpace(layer.SCPassword))
                return Error("Güvenli Bağlantı için bir şifre gerekiyor");
            if (layer.SCUserName.Length > MaxCredentialLength || layer.SCPassword.Length > MaxCredentialLength)
                return Error("Güvenli bağlantı kimlik bilgisi çok uzun");

            return new ServiceResult(ServiceResultType.Success);
        }

        private static string NormalizeOptional(string value) => value?.Trim();

        private static ServiceResult Success(string messageKey) =>
            new ServiceResult(ServiceResultType.Success, BusinessMessages.Get(messageKey));

        private static ServiceResult Error(string message, bool translate = false) =>
            new ServiceResult(ServiceResultType.Error, translate ? BusinessMessages.Get(message) : message);

        private static readonly string[] BuiltinBasemaps =
        {
            "topo", "streets", "satellite", "hybrid", "dark-gray", "gray",
            "national-geographic", "oceans", "osm", "terrain", "dark-gray-vector",
            "gray-vector", "streets-vector", "streets-night-vector",
            "streets-navigation-vector", "topo-vector", "streets-relief-vector"
        };
    }
}
