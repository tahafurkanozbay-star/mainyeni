using Business._Base;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountSearchViewModel : _BaseViewModel
    {
        public string searchText { get; set; }
        public int PageNumber { get; set; }
        public int PageSize { get; set; }

        public string order { get; set; } //Sıralama (A-Z,Z-A, yeniden eskiye, eskiden yeniye)
        public int TotalRowCount { get; internal set; }
    }
}
