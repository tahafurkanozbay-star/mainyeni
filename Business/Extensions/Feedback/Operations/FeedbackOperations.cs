using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.ViewModel;
using Business.Extensions.FeedbackService.Model;
using Business.Extensions.FeedbackService.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Extensions.FeedbackService.Operations
{
    public class FeedbackOperations : _BaseOperations
    {
        private const int DefaultPageSize = 25;
        private const int MaxPageNumber = 1_000_000;
        private const int MaxCityLength = 128;
        private const int MaxCountryLength = 128;
        private const int MaxDescriptionLength = 8_000;
        private const int MaxEmailLength = 320;
        private const int MaxFullNameLength = 256;
        private const int MaxAddressLength = 2_048;
        private const int MaxClientMetadataLength = 1_024;
        private const int MaxIpLength = 64;
        private readonly BusinessContext db;

        public FeedbackOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        private static ServiceResult ValidateAndNormalizeCreate(FeedbackViewModel viewModel)
        {
            if (viewModel == null)
            {
                return Error("Bildirim bilgileri gereklidir.");
            }

            if (!TryNormalizeRequired(viewModel.City, MaxCityLength, out var city))
                return Error("Şehir bilgisi boş olamaz veya izin verilen uzunluğu aşamaz.");
            if (!TryNormalizeRequired(viewModel.Country, MaxCountryLength, out var country))
                return Error("Ülke bilgisi boş olamaz veya izin verilen uzunluğu aşamaz.");
            if (!TryNormalizeRequired(viewModel.Description, MaxDescriptionLength, out var description))
                return Error("Açıklama boş olamaz veya izin verilen uzunluğu aşamaz.");
            if (!TryNormalizeRequired(viewModel.Email, MaxEmailLength, out var email))
                return Error("Eposta bilgisi boş olamaz veya izin verilen uzunluğu aşamaz.");
            if (!TryNormalizeRequired(viewModel.FullName, MaxFullNameLength, out var fullName))
                return Error("Ad bilgisi boş olamaz veya izin verilen uzunluğu aşamaz.");
            if (!TryNormalizeRequired(viewModel.Address, MaxAddressLength, out var address))
                return Error("Adres bilgisi boş olamaz veya izin verilen uzunluğu aşamaz.");
            if (!FeedbackTypes.List.Any(x => x.Id == viewModel.FeedbackType))
                return Error("Lütfen geçerli bir bildirim türü giriniz.");

            if (!TryNormalizeOptional(viewModel.Browser, MaxClientMetadataLength, out var browser) ||
                !TryNormalizeOptional(viewModel.Os, MaxClientMetadataLength, out var os) ||
                !TryNormalizeOptional(viewModel.Device, MaxClientMetadataLength, out var device) ||
                !TryNormalizeOptional(viewModel.Ip, MaxIpLength, out var ip))
            {
                return Error("İstemci bilgileri izin verilen uzunluğu aşıyor.");
            }

            viewModel.City = city;
            viewModel.Country = country;
            viewModel.Description = description;
            viewModel.Email = email;
            viewModel.FullName = fullName;
            viewModel.Address = address;
            viewModel.Browser = browser;
            viewModel.Os = os;
            viewModel.Device = device;
            viewModel.Ip = ip;
            return Success();
        }

        public ServiceResult Update(int id, int status, int actionTaken, UserSessionViewModel session) =>
            UpdateAsync(id, status, actionTaken, session, CancellationToken.None).GetAwaiter().GetResult();

        public async Task<ServiceResult> UpdateAsync(
            int id,
            int status,
            int actionTaken,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (session == null) return Error("Geçerli kullanıcı oturumu gerekiyor.");
            if (id <= 0) return Error("Kayıt bulunamadı");
            if (!FeedbackStatus.List.Any(x => x.Id == status)) return Error("Geçersiz bildirim durumu.");
            if (!FeedbackActions.List.Any(x => x.Id == actionTaken)) return Error("Geçersiz işlem türü.");

            var feedback = await db.Feedbacks
                .FirstOrDefaultAsync(x => x.Id == id, cancellationToken)
                .ConfigureAwait(false);
            if (feedback == null)
            {
                return Error("Kayıt bulunamadı");
            }

            feedback.UpdatedBy = session.UserId;
            feedback.UpdateDate = DateTime.UtcNow;
            feedback.Status = status;
            feedback.ActionTaken = actionTaken;

            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return Success();
        }

        public ServiceResult Create(FeedbackViewModel viewModel) =>
            CreateAsync(viewModel, CancellationToken.None).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateAsync(
            FeedbackViewModel viewModel,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var validateResult = ValidateAndNormalizeCreate(viewModel);
            if (!validateResult.IsSuccess) return validateResult;

            var feedbackType = FeedbackTypes.List.First(x => x.Id == viewModel.FeedbackType);
            var now = DateTime.UtcNow;
            var feedback = new Feedback
            {
                City = viewModel.City,
                Country = viewModel.Country,
                Description = viewModel.Description,
                Email = viewModel.Email,
                FeedbackType = feedbackType.Id,
                FullName = viewModel.FullName,
                Address = viewModel.Address,
                Status = FeedbackStatus.List[0].Id,
                ActionTaken = FeedbackActions.List[0].Id,
                Browser = viewModel.Browser,
                Os = viewModel.Os,
                Ip = viewModel.Ip,
                Device = viewModel.Device,
                CreateDate = now,
                UpdateDate = now,
                UpdatedBy = -1
            };

            await db.Feedbacks.AddAsync(feedback, cancellationToken).ConfigureAwait(false);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return new ServiceResult(ServiceResultType.Success, "Başarıyla kaydedildi");
        }

        public ServiceResult<DataList<FeedbackViewModel>> List(
            _BaseSearchViewModel viewModel,
            UserSessionViewModel session) =>
            ListAsync(viewModel, session, CancellationToken.None).GetAwaiter().GetResult();

        public async Task<ServiceResult<DataList<FeedbackViewModel>>> ListAsync(
            _BaseSearchViewModel viewModel,
            UserSessionViewModel session,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (viewModel == null)
                return ListError("Arama bilgisi gerekiyor.");
            if (session == null)
                return ListError("Geçerli kullanıcı oturumu gerekiyor.");

            var pageSize = viewModel.PageSize > 0 && viewModel.PageSize <= DefaultPageSize
                ? viewModel.PageSize
                : DefaultPageSize;
            var pageNumber = viewModel.PageNumber > 0 ? viewModel.PageNumber : 1;
            if (pageNumber > MaxPageNumber)
                return ListError("Sayfa numarası izin verilen sınırı aşıyor.");

            var skipRowsLong = ((long)pageNumber - 1L) * pageSize;
            if (skipRowsLong > Int32.MaxValue)
                return ListError("Sayfalama aralığı izin verilen sınırı aşıyor.");
            var skipRows = (int)skipRowsLong;

            var query = db.Feedbacks
                .AsNoTracking()
                .OrderByDescending(x => x.CreateDate)
                .ThenByDescending(x => x.Id);
            var count = await query.CountAsync(cancellationToken).ConfigureAwait(false);
            var resultList = await query
                .Skip(skipRows)
                .Take(pageSize)
                .Select(y => new FeedbackViewModel
                {
                    ActionTaken = y.ActionTaken,
                    Address = y.Address,
                    Browser = y.Browser,
                    City = y.City,
                    Country = y.Country,
                    CreateDate = y.CreateDate,
                    Description = y.Description,
                    Device = y.Device,
                    Email = y.Email,
                    FeedbackType = y.FeedbackType,
                    FullName = y.FullName,
                    Id = y.Id,
                    Ip = y.Ip,
                    Os = y.Os,
                    Status = y.Status,
                    UpdateDate = y.UpdateDate,
                    UpdatedBy = y.UpdatedBy
                })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            return new ServiceResult<DataList<FeedbackViewModel>>(
                ServiceResultType.Success,
                new DataList<FeedbackViewModel>
                {
                    TotalRowCount = count,
                    CurrentPage = pageNumber,
                    PageSize = pageSize,
                    Data = resultList
                });
        }

        public ServiceResult<FeedbackViewModel> GetById(int id) =>
            GetByIdAsync(id, CancellationToken.None).GetAwaiter().GetResult();

        public async Task<ServiceResult<FeedbackViewModel>> GetByIdAsync(
            int id,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (id <= 0)
                return new ServiceResult<FeedbackViewModel>(ServiceResultType.Error, "Kayıt bulunamadı", null);

            var model = await db.Feedbacks
                .AsNoTracking()
                .FirstOrDefaultAsync(x => x.Id == id, cancellationToken)
                .ConfigureAwait(false);
            if (model == null)
                return new ServiceResult<FeedbackViewModel>(ServiceResultType.Error, "Kayıt bulunamadı", null);

            return new ServiceResult<FeedbackViewModel>(ServiceResultType.Success, "", new FeedbackViewModel
            {
                Id = model.Id,
                CreateDate = model.CreateDate,
                Browser = model.Browser,
                Device = model.Device,
                Ip = model.Ip,
                Os = model.Os,
                FullName = model.FullName,
                City = model.City,
                Country = model.Country,
                Description = model.Description,
                Email = model.Email,
                Address = model.Address,
                FeedbackType = model.FeedbackType,
                Status = model.Status,
                ActionTaken = model.ActionTaken,
                UpdateDate = model.UpdateDate,
                UpdatedBy = model.UpdatedBy
            });
        }

        private static bool TryNormalizeRequired(string value, int maxLength, out string normalized)
        {
            normalized = value?.Trim() ?? String.Empty;
            return normalized.Length > 0 && normalized.Length <= maxLength;
        }

        private static bool TryNormalizeOptional(string value, int maxLength, out string normalized)
        {
            normalized = value?.Trim() ?? String.Empty;
            return normalized.Length <= maxLength;
        }

        private static ServiceResult Success() => new(ServiceResultType.Success);
        private static ServiceResult Error(string message) => new(ServiceResultType.Error, message);

        private static ServiceResult<DataList<FeedbackViewModel>> ListError(string message) =>
            new(
                ServiceResultType.Error,
                message,
                new DataList<FeedbackViewModel>
                {
                    TotalRowCount = 0,
                    CurrentPage = 1,
                    PageSize = DefaultPageSize,
                    Data = new System.Collections.Generic.List<FeedbackViewModel>()
                });
    }
}
