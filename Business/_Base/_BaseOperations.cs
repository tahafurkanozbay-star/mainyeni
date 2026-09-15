using Business.Core.Model;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using Toolbox.Security.Url;

namespace Business._Base
{
    public abstract class _BaseOperations
    {
        #region Common Methods For Db Access

        /// <summary>
        /// Returns field names for an entity.
        /// </summary>
        public string[] GetFieldNames<T>(T entity)
        {
            return typeof(T)
                .GetProperties()
                .Select(property => property.Name)
                .ToArray();
        }

        /// <summary>
        /// Gets an item from DbContext using the given expression and navigation properties.
        /// </summary>
        public T GetSingleItem<T>(
            DbContext db,
            Expression<Func<T, bool>> exp,
            params Expression<Func<T, object>>[] navigationProperties)
            where T : class
        {
            if (db == null)
            {
                throw new ArgumentNullException(nameof(db));
            }
            if (exp == null)
            {
                throw new ArgumentNullException(nameof(exp));
            }

            IQueryable<T> query = db.Set<T>();
            foreach (var navigationProperty in navigationProperties ?? Array.Empty<Expression<Func<T, object>>>())
            {
                query = query.Include(navigationProperty);
            }

            return query.FirstOrDefault(exp);
        }

        /// <summary>
        /// Gets an item list from DbContext using the optional expression and navigation properties.
        /// Read-only list queries are no-tracking by default.
        /// </summary>
        public List<T> GetItemList<T>(
            DbContext db,
            Expression<Func<T, bool>> exp,
            params Expression<Func<T, object>>[] navigationProperties)
            where T : class
        {
            if (db == null)
            {
                throw new ArgumentNullException(nameof(db));
            }

            IQueryable<T> query = db.Set<T>();
            foreach (var navigationProperty in navigationProperties ?? Array.Empty<Expression<Func<T, object>>>())
            {
                query = query.Include(navigationProperty);
            }

            query = query.AsNoTracking();
            if (exp != null)
            {
                query = query.Where(exp);
            }

            return query.ToList();
        }

        public bool IsItemExist<T>(
            DbContext db,
            Expression<Func<T, bool>> exp,
            params Expression<Func<T, object>>[] navigationProperties)
            where T : class
        {
            if (db == null)
            {
                throw new ArgumentNullException(nameof(db));
            }

            IQueryable<T> query = db.Set<T>();
            foreach (var navigationProperty in navigationProperties ?? Array.Empty<Expression<Func<T, object>>>())
            {
                query = query.Include(navigationProperty);
            }

            return exp == null ? query.Any() : query.Any(exp);
        }

        public T GetEntityByGuid<T>(
            DbContext db,
            string guid,
            params Expression<Func<T, object>>[] navigationProperties)
            where T : _BaseModel
        {
            if (string.IsNullOrWhiteSpace(guid))
            {
                return null;
            }

            return GetSingleItem<T>(
                db,
                entity => !entity.IsDeleted && entity.Guid == guid,
                navigationProperties);
        }

        public T GetEntityByEncryptedGuid<T>(
            DbContext db,
            string encryptedGuid,
            params Expression<Func<T, object>>[] navigationProperties)
            where T : _BaseModel
        {
            var guid = ParameterEncryptionUtils.DecryptGuid(encryptedGuid);
            return GetEntityByGuid<T>(db, guid.ToString(), navigationProperties);
        }

        public T GetEntityById<T>(
            DbContext db,
            int id,
            params Expression<Func<T, object>>[] navigationProperties)
            where T : _BaseModel
        {
            return GetSingleItem<T>(
                db,
                entity => !entity.IsDeleted && entity.Id == id,
                navigationProperties);
        }

        public void DeleteEntryPermanent(DbContext db, _BaseModel entry)
        {
            if (db == null)
            {
                throw new ArgumentNullException(nameof(db));
            }
            if (entry == null)
            {
                throw new ArgumentNullException(nameof(entry));
            }

            db.Entry(entry).State = EntityState.Deleted;
            db.SaveChanges();
        }

        #endregion
    }
}
