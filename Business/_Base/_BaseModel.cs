using System.Numerics;
using System;
using Toolbox.Date;

namespace Business._Base
{                                                                                                                                                       
    public abstract class _BaseModel
    {
        public int Id { get; set; }
        public string Guid { get; set; }

        public long CreateDate { get; set; }
        public int CreatedBy { get; set; }

        public long UpdateDate { get; set; }
        public int UpdatedBy { get; set; }

        public bool IsDeleted { get; set; }
        public long DeleteDate { get; set; }
        public int DeletedBy { get; set; }

        public void SetCreate(int userId=-1)
        {
            IsDeleted = false;
            CreatedBy = userId;
            CreateDate = DateTimeUtils.ToTimeStamp(DateTime.Now);
            Guid = System.Guid.NewGuid().ToString();
        }

        public void SetUpdate(int userId=-1)
        {
            UpdatedBy=userId;
            UpdateDate = DateTimeUtils.ToTimeStamp(DateTime.Now);
        }

        public void SetDelete(int userId=-1)
        {
            IsDeleted = true;
            DeletedBy= userId;
            DeleteDate = DateTimeUtils.ToTimeStamp(DateTime.Now);
        }


    }
}
