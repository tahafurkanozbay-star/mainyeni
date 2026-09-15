using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Permissions;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Business.Extensions.Gis.ViewModel;
using Toolbox;
using Toolbox.Text;
using Microsoft.EntityFrameworkCore;
using Business.Extensions.Gis.Model;

namespace Business.Extensions.Gis.Operations
{
    public class GisBookmarkOperations : _BaseOperations
    {
        private BusinessContext gisDb;

        public GisBookmarkOperations(BusinessContext gisContext)
        {
            this.gisDb = gisContext;
        }

        public ServiceResult<List<GisBookmarkViewModel>> GetBookmarksOfUser(UserSessionViewModel session)
        {
            using (gisDb)
            {
                var list= gisDb.GisBookmarks.Where(bookmark => bookmark.UserId == session.UserId && !bookmark.IsDeleted)
                    .Select(bookmark=> new GisBookmarkViewModel()
                    {
                        
                        Center=bookmark.Center,
                        Id=bookmark.Id,
                        Title=bookmark.Title,
                        Zoom=bookmark.Zoom

                    }).ToList();

                return new ServiceResult<List<GisBookmarkViewModel>>(ServiceResultType.Success, "", list);
            }
        }

        public ServiceResult<GisBookmarkViewModel> Create(GisBookmarkViewModel viewModel,UserSessionViewModel session)
        {
            using (gisDb)
            {

                var validationResult = validateCreate(viewModel);
                if (validationResult.IsSuccess)
                {
                    var bookmark = new GisBookmark();
                    bookmark.SetCreate(session.UserId);

                    bookmark.Center = viewModel.Center;
                    bookmark.Title = TextUtils.Capitalize(viewModel.Title);
                    bookmark.UserId = viewModel.UserId;

                    bookmark.Zoom = viewModel.Zoom;

                    gisDb.GisBookmarks.Add(bookmark);
                    gisDb.SaveChanges();

                    return new ServiceResult<GisBookmarkViewModel>(ServiceResultType.Success, "", viewModel);
                }
                else
                {
                    return new ServiceResult<GisBookmarkViewModel>(ServiceResultType.Error,validationResult.Message,null);
                }

                
            }
        }

        public ServiceResult Delete(int id, UserSessionViewModel session)
        {
            using (gisDb)
            {
                var bookmark= gisDb.GisBookmarks.Where(x => x.Id == id 
                                                    && x.UserId==session.UserId 
                                                    && !x.IsDeleted).FirstOrDefault();
                                                    
                if (bookmark!=null) {

                    bookmark.SetDelete(session.UserId);
                    gisDb.Entry<GisBookmark>(bookmark).State = EntityState.Modified;
                    gisDb.SaveChanges();

                    return new ServiceResult(ServiceResultType.Success);
                }
                else
                {
                    return new ServiceResult(ServiceResultType.Error, "Yer imi bulunamadı");
                }
            }
        }

        private ServiceResult validateCreate(GisBookmarkViewModel viewModel)
        {
            if (viewModel!=null) {
                if (string.IsNullOrEmpty(viewModel.Title))
                {
                    return new ServiceResult(ServiceResultType.Error, "Title boş olamaz");
                }

                if (string.IsNullOrEmpty(viewModel.Center))
                {
                    return new ServiceResult(ServiceResultType.Error, "Center boş olamaz");
                }

                if (string.IsNullOrEmpty(viewModel.Zoom))
                {
                    return new ServiceResult(ServiceResultType.Error, "Zoom boş olamaz");
                }

                return new ServiceResult(ServiceResultType.Success);
            }
            else
            {
                return new ServiceResult(ServiceResultType.Error,"Lütfen gerekli alanları doldurunuz");
            }
            
        }
    }
}