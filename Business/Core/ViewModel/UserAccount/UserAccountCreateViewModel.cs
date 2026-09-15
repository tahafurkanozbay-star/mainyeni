using Business._Base;
using Business.Core.Model;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountCreateViewModel : _BaseViewModel
    {
        public string username { get; set; }
        public string firstname { get; set; }
        public string mobilePhone { get; set; }
        public string lastname { get; set; }
        public string password { get; set; }
        public string passwordrepeat { get; set; }
        public int accountType { get; set; }
        public string roles { get; set; }
    }
}
