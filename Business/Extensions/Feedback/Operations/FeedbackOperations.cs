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


namespace Business.Extensions.FeedbackService.Operations
{
    public class FeedbackOperations : _BaseOperations
    {

        private BusinessContext db;

        public FeedbackOperations(BusinessContext _context)
        {
            this.db = _context;
        }

        private ServiceResult validateCreate(FeedbackViewModel viewModel)
        {

            if (String.IsNullOrEmpty(viewModel.City))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen şehir giriniz.");
            }

            if (String.IsNullOrEmpty(viewModel.Country))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen ülke giriniz.");
            }

            if (String.IsNullOrEmpty(viewModel.Description))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen açıklama giriniz.");

            }

            if (String.IsNullOrEmpty(viewModel.Email))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen eposta giriniz.");
            }

            /*
            if (viewModel.FeedbackType == FeedbackType.NAVIGATION_IS_WRONG)
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen bildirim türü giriniz.");
            }
            */

            if (String.IsNullOrEmpty(viewModel.FullName))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen adınızı giriniz.");
            }

            if (String.IsNullOrEmpty(viewModel.Address))
            {
                return new ServiceResult(ServiceResultType.Error, "Lütfen adres giriniz.");
            }

            return new ServiceResult(ServiceResultType.Success);

        }

        public ServiceResult Update(int id, int status, int actionTaken, UserSessionViewModel session)
        {

            using (db)
            {
                var feedback = db.Feedbacks.Where(x => x.Id == id).FirstOrDefault();

                feedback.UpdatedBy = session.UserId;
                feedback.UpdateDate = DateTime.Now;
                feedback.Status = status;
                feedback.ActionTaken = actionTaken;

                db.Entry(feedback).State = EntityState.Modified;
                db.SaveChanges();
                return new ServiceResult(ServiceResultType.Success);
            }


        }

        public ServiceResult Create(FeedbackViewModel viewModel)
        {


            var validateResult = validateCreate(viewModel);

            if (!validateResult.IsSuccess)
            {
                return validateResult;
            }


            var feedback = new Feedback();
            feedback.City = viewModel.City?.Trim();
            feedback.Country = viewModel.Country?.Trim();
            feedback.Description = viewModel.Description?.Trim();
            feedback.Email = viewModel.Email?.Trim();

            var _feedBackType = FeedbackTypes.List.Where(x => x.Id == viewModel.FeedbackType).FirstOrDefault();

            feedback.FeedbackType = _feedBackType.Id;
            feedback.FullName = viewModel.FullName?.Trim();
            feedback.Address = viewModel.Address?.Trim();

            feedback.Status = FeedbackStatus.List[0].Id;//Açık
            feedback.ActionTaken = FeedbackActions.List[0].Id;//Açık

            feedback.Browser = viewModel.Browser?.Trim();
            feedback.Os = viewModel.Os?.Trim();
            feedback.Ip = viewModel.Ip?.Trim();
            feedback.Device = viewModel.Device?.Trim();

            feedback.CreateDate = DateTime.Now;
            feedback.UpdateDate = feedback.CreateDate;
            feedback.UpdatedBy = -1;


            using (db)
            {
                db.Feedbacks.Add(feedback);
                db.SaveChanges();
                return new ServiceResult(ServiceResultType.Success, "Başarıyla kaydedildi");

            }

        }



        public ServiceResult<DataList<FeedbackViewModel>> List(_BaseSearchViewModel viewModel, UserSessionViewModel session)
        {
            using (db)
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
                int skipRows = (viewModel.PageNumber- 1) * viewModel.PageSize;

                var list = db.Feedbacks.OrderByDescending(x => x.CreateDate);

                var count = list.Count();
                
                var resultList = list.Skip(skipRows).Take(viewModel.PageSize).Select(y => new FeedbackViewModel()
                {
                    ActionTaken= y.ActionTaken,
                    Address=y.Address,
                    Browser=y.Browser,
                    City=y.City,
                    Country=y.Country,
                    CreateDate=y.CreateDate,
                    Description=y.Description,
                    Device=y.Device,
                    Email=y.Email,
                    FeedbackType=y.FeedbackType,
                    FullName=y.FullName,
                    Id=y.Id,
                    Ip=y.Ip,
                    Os=y.Os,
                    Status=y.Status,
                    UpdateDate=y.UpdateDate,
                    UpdatedBy=y.UpdatedBy
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

        }

        public ServiceResult<FeedbackViewModel> GetById(int Id)
        {

            using (db)
            {
                var model = db.Feedbacks.Where(x => x.Id == Id).FirstOrDefault();
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
                else
                {
                    return new ServiceResult<FeedbackViewModel>(ServiceResultType.Error, "Kayıt bulunamadı", null);
                }
            }

        }

    }
}
