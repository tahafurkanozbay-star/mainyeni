using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.ViewModel;
using Business.Extensions.FeedbackService.Model;
using Business.Extensions.FeedbackService.ViewModel;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Extensions.FeedbackService.Operations
{
    public class FeedbackOperations : _BaseOperations
    {
        private readonly BusinessContext db;

        public FeedbackOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        private ServiceResult ValidateCreate(FeedbackViewModel viewModel)
        {
            if (viewModel == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Bildirim bilgileri gereklidir.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.City))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen şehir giriniz.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.Country))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen ülke giriniz.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.Description))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen açıklama giriniz.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.Email))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen eposta giriniz.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.FullName))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen adınızı giriniz.");
            }

            if (String.IsNullOrWhiteSpace(viewModel.Address))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen adres giriniz.");
            }

            if (!FeedbackTypes.List.Any(x => x.Id == viewModel.FeedbackType))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen geçerli bir bildirim türü giriniz.");
            }

            return new ServiceResult(ServiceResultType.Success);
        }

        public ServiceResult Update(int id, int status, int actionTaken, UserSessionViewModel session)
        {
            var feedback = db.Feedbacks.FirstOrDefault(x => x.Id == id);
            if (feedback == null)
            {
                return new ServiceResult(ServiceResultType.Error, "Kayıt bulunamadı");
            }

            feedback.UpdatedBy = session.UserId;
            feedback.UpdateDate = DateTime.Now;
            feedback.Status = status;
            feedback.ActionTaken = actionTaken;

            db.Entry(feedback).State = EntityState.Modified;
            db.SaveChanges();
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
            if (!validateResult.IsSuccess)
            {
                return validateResult;
            }

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
            int pageSize = 25;
            if (viewModel.PageSize > pageSize || viewModel.PageSize <= 0)
            {
                viewModel.PageSize = pageSize;
            }

            if (viewModel.PageNumber == 0)
            {
                viewModel.PageNumber = 1;
            }
            int skipRows = (viewModel.PageNumber - 1) * viewModel.PageSize;

            var list = db.Feedbacks.OrderByDescending(x => x.CreateDate);
            var count = list.Count();
            var resultList = list.Skip(skipRows).Take(viewModel.PageSize).Select(y => new FeedbackViewModel()
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
            }).ToList();

            var dataList = new DataList<FeedbackViewModel>()
            {
                TotalRowCount = count,
                CurrentPage = viewModel.PageNumber,
                PageSize = viewModel.PageSize,
                Data = resultList
            };

            return new ServiceResult<DataList<FeedbackViewModel>>(ServiceResultType.Success, dataList);
        }

        public ServiceResult<FeedbackViewModel> GetById(int Id)
        {
            var model = db.Feedbacks.FirstOrDefault(x => x.Id == Id);
            if (model != null)
            {
                var viewModel = new FeedbackViewModel()
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
                };

                return new ServiceResult<FeedbackViewModel>(ServiceResultType.Success, "", viewModel);
            }

            return new ServiceResult<FeedbackViewModel>(ServiceResultType.Error, "Kayıt bulunamadı", null);
        }
    }
}
