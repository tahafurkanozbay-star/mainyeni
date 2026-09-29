using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.Resources;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Core.Operations
{
    public class AppConfigOperations : _BaseOperations
    {
        private readonly BusinessContext db;

        public AppConfigOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public ServiceResult<AppConfig> GetConfig(string key) =>
            GetConfigAsync(key).GetAwaiter().GetResult();

        public async Task<ServiceResult<AppConfig>> GetConfigAsync(
            string key,
            CancellationToken cancellationToken = default)
        {
            var normalizedKey = NormalizeKey(key);
            if (normalizedKey == null)
            {
                return Error("Konfigürasyon anahtarı geçersiz", key);
            }

            cancellationToken.ThrowIfCancellationRequested();

            var config = await db.AppConfigs
                .AsNoTracking()
                .Where(x => !x.IsDeleted && x.ConfigKey == normalizedKey)
                .OrderBy(x => x.Id)
                .FirstOrDefaultAsync(cancellationToken)
                .ConfigureAwait(false);

            config ??= new AppConfig
            {
                ConfigKey = normalizedKey,
                ConfigValue = "{}"
            };

            return new ServiceResult<AppConfig>(ServiceResultType.Success, string.Empty, config);
        }

        public ServiceResult<AppConfig> Create(AppConfig viewModel, UserSessionViewModel session) =>
            CreateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult<AppConfig>> CreateAsync(
            AppConfig viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            if (!TryValidateMutation(viewModel, session, out var normalizedKey, out var validationError))
            {
                return validationError!;
            }

            cancellationToken.ThrowIfCancellationRequested();

            var exists = await db.AppConfigs
                .AsNoTracking()
                .AnyAsync(x => !x.IsDeleted && x.ConfigKey == normalizedKey, cancellationToken)
                .ConfigureAwait(false);

            if (exists)
            {
                return Error("Konfigürasyon anahtarı zaten mevcut", normalizedKey);
            }

            var model = new AppConfig
            {
                ConfigKey = normalizedKey!,
                ConfigValue = viewModel.ConfigValue
            };
            model.SetCreate(session.UserId);

            await db.AppConfigs.AddAsync(model, cancellationToken).ConfigureAwait(false);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            return new ServiceResult<AppConfig>(ServiceResultType.Success, BusinessMessages.Get("UPDATED"), model);
        }

        public ServiceResult<AppConfig> Update(AppConfig viewModel, UserSessionViewModel session) =>
            UpdateAsync(viewModel, session).GetAwaiter().GetResult();

        public async Task<ServiceResult<AppConfig>> UpdateAsync(
            AppConfig viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            if (!TryValidateMutation(viewModel, session, out var normalizedKey, out var validationError))
            {
                return validationError!;
            }

            cancellationToken.ThrowIfCancellationRequested();

            var model = await db.AppConfigs
                .Where(x => !x.IsDeleted && x.ConfigKey == normalizedKey)
                .OrderBy(x => x.Id)
                .FirstOrDefaultAsync(cancellationToken)
                .ConfigureAwait(false);

            if (model == null)
            {
                return await CreateAsync(viewModel, session, cancellationToken).ConfigureAwait(false);
            }

            model.ConfigKey = normalizedKey!;
            model.ConfigValue = viewModel.ConfigValue;
            model.SetUpdate(session.UserId);

            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            return new ServiceResult<AppConfig>(ServiceResultType.Success, BusinessMessages.Get("UPDATED"), model);
        }

        public AppConfig GetByKey(string key) =>
            GetByKeyAsync(key).GetAwaiter().GetResult();

        public async Task<AppConfig?> GetByKeyAsync(
            string key,
            CancellationToken cancellationToken = default)
        {
            var normalizedKey = NormalizeKey(key);
            if (normalizedKey == null)
            {
                return null;
            }

            return await db.AppConfigs
                .AsNoTracking()
                .Where(x => !x.IsDeleted && x.ConfigKey == normalizedKey)
                .OrderBy(x => x.Id)
                .FirstOrDefaultAsync(cancellationToken)
                .ConfigureAwait(false);
        }

        private static bool TryValidateMutation(
            AppConfig? viewModel,
            UserSessionViewModel? session,
            out string? normalizedKey,
            out ServiceResult<AppConfig>? error)
        {
            normalizedKey = null;
            error = null;

            if (viewModel == null)
            {
                error = Error("Konfigürasyon gövdesi geçersiz", null);
                return false;
            }

            if (session == null)
            {
                error = Error("Kullanıcı oturumu geçersiz", viewModel.ConfigKey);
                return false;
            }

            normalizedKey = NormalizeKey(viewModel.ConfigKey);
            if (normalizedKey == null)
            {
                error = Error("Konfigürasyon anahtarı geçersiz", viewModel.ConfigKey);
                return false;
            }

            if (viewModel.ConfigValue == null)
            {
                error = Error("Konfigürasyon değeri geçersiz", normalizedKey);
                return false;
            }

            return true;
        }

        private static string? NormalizeKey(string? key)
        {
            if (String.IsNullOrWhiteSpace(key))
            {
                return null;
            }

            var normalized = key.Trim();
            return normalized.Length <= 256 ? normalized : null;
        }

        private static ServiceResult<AppConfig> Error(string message, string? key) =>
            new ServiceResult<AppConfig>(
                ServiceResultType.Error,
                message,
                new AppConfig
                {
                    ConfigKey = key ?? String.Empty,
                    ConfigValue = "{}"
                });
    }
}
