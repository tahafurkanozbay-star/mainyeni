using Business.Core.ViewModel;
using System;
using System.Collections.Generic;

namespace Business.Core.Common
{
    public class DataList<T>
    {
          public long TotalRowCount {get;set;}
          public int CurrentPage {get;set;}
          public int PageSize {get;set;}
          
          public List<T> Data { get; set; }

    }
}
