using Business.Core.ViewModel;
using System;

namespace Business.Core.Common
{
    public class ServiceResult
    {
        public ServiceResultType Type { get; set; }
        public String Message { get; set; }

        public ServiceResult(){}

        public ServiceResult(ServiceResultType resultType, String Message = "")
        {
            this.Type = resultType;
            this.Message = Message;
        }


        public ServiceResult(Exception ex)
        {
            this.Type = ServiceResultType.Error;
            this.Message = "Bir hata oluştu";
            //this.Message = ex.Message;
        }

        public bool IsSuccess
        {
            get { return (this.Type == ServiceResultType.Success); }
        }
    }


    

    public class ServiceResult<T> : ServiceResult
    {
    
        public T Data { get; set; }

        public ServiceResult(ServiceResultType success)
        {
        }

        public ServiceResult(ServiceResultType resultType,T data)
        {
            this.Type = resultType;
            this.Data = data;
        }

        public ServiceResult(ServiceResultType resultType, string Message, T data)
        {
            this.Type = resultType;
            this.Message = Message;
            this.Data = data;
        }

        public ServiceResult(Exception ex)
        {
            this.Type = ServiceResultType.Error;
            //this.Message = "Bir hata oluştu";
            this.Message = ex.Message;
        }

        public ServiceResult(ServiceResultType resultType, Exception ex, T data)
        {
            this.Type = resultType;
            this.Data = data;

            //this.Message = "Bir hata oluştu";
            this.Message = ex.Message;
        }
    }

    public enum ServiceResultType
    {
        Success = 10,
        Error = 20
    }
}