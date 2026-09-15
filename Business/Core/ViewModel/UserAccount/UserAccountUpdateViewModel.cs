using Business._Base;
using Business.Core.Model;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountUpdateViewModel  : _BaseViewModel
    {
        public string UserName { get; set; }
        public string FirstName { get; set; }
        public string MobilePhone { get; set; }
        public string LastName { get; set; }
        
        public int AccountType { get; set; }
        public string Roles { get; set; }
    }
}
