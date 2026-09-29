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
        private readonly BusinessContext db;

        public FeedbackOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        private static ServiceResult ValidateCreate(FeedbackViewModel viewModel)
        {
            if (viewModel == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Bildirim bilgileri gereklidir.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.City)) return new ServiceResult(ServiceResultType.Error, "Lütfen şehir giriniz.");
            if (String.IsNullOrWhiteSpace(viewModel.Country)) return new ServiceResult(ServiceResultType.Error, "Lütfen ülke giriniz.");
            if (String.IsNullOrWhiteSpace(viewModel.Description)) return new ServiceResult(ServiceResultType.Error, "Lütfen açıklama giriniz.");
            if (String.IsNullOrWhiteSpace(viewModel.Email)) return new ServiceResult(ServiceResultType.Error, "Lütfen eposta giriniz.");
            if (String.IsNullOrWhiteSpace(viewModel.FullName)) return new ServiceResult(ServiceResultType.Error, "Lütfen adınızı giriniz.");
            if (String.IsNullOrWhiteSpace(viewModel.Address)) return new ServiceResult(ServiceResultType.Error, "Lütfen adres giriniz.");
            if (!FeedbackTypes.List.Any(x => x.Id == viewModel.FeedbackType)) return new ServiceResult(ServiceResultType.Error, "Lütfen geçerli bir bildirim türü giriniz.");

            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult Update(int id, int status, int actionTaken, UserSessionViewModel session)
        {
            return UpdateAsync(id, status, actionTaken, session, CancellationToken.None).GetAwaiter().GetResult();
        }

        public async Task<ServiceResult> UpdateAsync(int id, int status, int actionTaken, UserSessionViewModel session, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (session == null) throw new ArgumentNullException(nameof(session));

            var feedback = await db.Feedbacks.FirstOrDefaultAsync(x => x.Id == id, cancellationToken).ConfigureAwait(false);
            if (feedback == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Kayıt bulunamadı");
            }

            feedback.UpdatedBy = session.UserId;
            feedback.UpdateDate = DateTime.Now;
            feedback.Status = status;
            feedback.ActionTaken = actionTaken;

            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult Create(FeedbackViewModel viewModel)
        {
            return CreateAsync(viewModel, CancellationToken.None).GetAwaiter().GetResult();
        }

        public async Task<ServiceResult> CreateAsync(FeedbackViewModel viewModel, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var validateResult = ValidateCreate(viewModel);
            if (!validateResult.IsSuccess) return validateResult;

            var feedbackType = FeedbackTypes.List.First(x => x.Id == viewModel.FeedbackType);
            var feedback = new Feedback
            {
                City = viewModel.City?.Trim(),
                Country = viewModel.Country?.Trim(),
                Description = viewModel.Description?.Trim(),
                Email = viewModel.Email?.Trim(),
                FeedbackType = feedbackType.Id,
                FullName = viewModel.FullName?.Trim(),
                Address = viewModel.Address?.Trim(),
                Status = FeedbackStatus.List[0].Id,
                ActionTaken = FeedbackActions.List[0].Id,
                Browser = viewModel.Browser?.Trim(),
                Os = viewModel.Os?.Trim(),
                Ip = viewModel.Ip?.Trim(),
                Device = viewModel.Device?.Trim(),
                CreateDate = DateTime.Now,
                UpdatedBy = -1
            };
            feedback.UpdateDate = feedback.CreateDate;

            await db.Feedbacks.AddAsync(feedback, cancellationToken).ConfigureAwait(false);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return new ServiceResult(ServiceResultType.Success, "Başarıyla kaydedildi");
        }

        public ServiceResult<DataList<FeedbackViewModel>> List(_BaseSearchViewModel viewModel, UserSessionViewModel session)
        {
            return ListAsync(viewModel, session, CancellationToken.None).GetAwaiter().GetResult();
        }

        public async Task<ServiceResult<DataList<FeedbackViewModel>>> ListAsync(_BaseSearchViewModel viewModel, UserSessionViewModel session, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (viewModel == null) throw new ArgumentNullException(nameof(viewModel));
            if (session == null) throw new ArgumentNullException(nameof(session));

            var pageSize = viewModel.PageSize > 0 && viewModel.PageSize <= DefaultPageSize ? viewModel.PageSize : DefaultPageSize;
            var pageNumber = viewModel.PageNumber > 0 ? viewModel.PageNumber : 1;
            var skipRows = checked((pageNumber - 1) * pageSize);

            var query = db.Feedbacks.AsNoTracking().OrderByDescending(x => x.CreateDate);
            var count = await query.CountAsync(cancellationToken).ConfigureAwait(false);
            var resultList = await query.Skip(skipRows).Take(pageSize).Select(y => new FeedbackViewModel
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
            }).ToListAsync(cancellationToken).ConfigureAwait(false);

            return new ServiceResult<DataList<FeedbackViewModel>>(ServiceResultType.Success, new DataList<FeedbackViewModel>
            {
                TotalRowCount = count,
                CurrentPage = pageNumber,
                PageSize = pageSize,
                Data = resultList
            });
        }

        public ServiceResult<FeedbackViewModel> GetById(int id)
        {
            return GetByIdAsync(id, CancellationToken.None).GetAwaiter().GetResult();
        }

        public async Task<ServiceResult<FeedbackViewModel>> GetByIdAsync(int id, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var model = await db.Feedbacks.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, cancellationToken).ConfigureAwait(false);
            if (model == null) return new ServiceResult<FeedbackViewModel>(ServiceResultType.Error, "Kayıt bulunamadı", null);

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
    }
}
