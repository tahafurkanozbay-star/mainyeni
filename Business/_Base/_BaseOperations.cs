using Business.Core.Common;
using Business.Core.Model;
using Business.Core.ViewModel;
using Business.Core.Context;
using Toolbox.Security.Url;
using Microsoft.EntityFrameworkCore;
using Nest;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Text;
using Toolbox.Generic;
using Toolbox.Serialization;
using Toolbox.Text;
using System.Threading.Tasks;

namespace Business._Base
{
    public abstract class _BaseOperations
    {        
    
        #region Common Methods For Db Access

        /// <summary>
        /// Returns field names for an entity
        /// </summary>
        /// <typeparam name="T">Entity Class</typeparam>
        /// <param name="Entity">Entity</param>
        /// <returns></returns>
        public String[] GetFieldNames<T>(T Entity)
        {
            var names = typeof(T).GetProperties()
                        .Select(property => property.Name)
                        .ToArray();

            return names;
        }

        /// <summary>
        /// Gets an item from DbContext in a given expression and navigation property
        /// </summary>
        /// <typeparam name="T"></typeparam>
        /// <param name="db"></param>
        /// <param name="exp"></param>
        /// <returns></returns>
        public T GetSingleItem<T>(DbContext db, Expression<Func<T, bool>> exp, params Expression<Func<T, object>>[] navigationProperties) where T : class
        {
            T item = null;
            try
            {
                IQueryable<T> dbQuery = db.Set<T>();

                foreach (Expression<Func<T, object>> navigationProperty in navigationProperties)
                {
                    dbQuery = dbQuery.Include<T, object>(navigationProperty);
                }
                    
                item = dbQuery
                    .Where(exp)
                    //                .AsNoTracking() //Don't track any changes for the selected item
                    .FirstOrDefault(); //Apply where clause
            }
            catch (Exception ex)
            {
                throw ex;
            }

         

            return item;
        }

        /// <summary>
        /// Gets item list from DbContext in a given expression and navigation property
        /// </summary>
        /// <typeparam name="T"></typeparam>
        /// <param name="db"></param>
        /// <param name="exp"></param>
        /// <returns></returns>
        public List<T> GetItemList<T>(DbContext db, Expression<Func<T, bool>> exp, params Expression<Func<T, object>>[] navigationProperties) where T : class
        {
            List<T> list = null;

            try
            {
                IQueryable<T> dbQuery = db.Set<T>();

                foreach (Expression<Func<T, object>> navigationProperty in navigationProperties)
                    dbQuery = dbQuery.Include<T, object>(navigationProperty);

                if (exp != null)
                {
                    list = dbQuery
                    .Where(exp)
                    .AsNoTracking()
                    .ToList<T>();
                }
                else
                {
                    list = dbQuery
                    .AsNoTracking()
                    .ToList<T>();
                }
            }
            catch (Exception ex)
            {
                throw ex;
            }

            return list;
        }

        /// <summary>
        /// Returns true if there exists any item in DbContext
        /// </summary>
        /// <typeparam name="T"></typeparam>
        /// <param name="db"></param>
        /// <param name="exp"></param>
        /// <returns></returns>
        public bool IsItemExist<T>(DbContext db, Expression<Func<T, bool>> exp, params Expression<Func<T, object>>[] navigationProperties) where T : class
        {
            List<T> list = GetItemList(db, exp, navigationProperties);
            if (list.Count > 0)
            {
                return true;
            }
            else
            {
                return false;
            }
        }


        public T GetEntityByGuid<T>(DbContext db, string guid, params Expression<Func<T, object>>[] navigationProperties) where T : _BaseModel
        {
            var item=GetSingleItem<T>(db, e => !e.IsDeleted && e.Guid == guid, navigationProperties);
            return item;
        }

        public T GetEntityByEncryptedGuid<T>(DbContext db, String encryptedGuid, params Expression<Func<T, object>>[] navigationProperties) where T : _BaseModel
        {
            Guid guid = ParameterEncryptionUtils.DecryptGuid(encryptedGuid);
            return GetEntityByGuid<T>(db, guid.ToString(), navigationProperties);
        }

        public T GetEntityById<T>(DbContext db, int Id, params Expression<Func<T, object>>[] navigationProperties) where T : _BaseModel
        {
            return GetSingleItem<T>(db, e => !e.IsDeleted && e.Id == Id, navigationProperties);
        }

        public void DeleteEntryPermanent(DbContext db, _BaseModel entry)
        {
           
                db.Entry(entry).State = EntityState.Deleted;
                db.SaveChanges();
            
        }

        #endregion Common Methods For Db Access





    }
}