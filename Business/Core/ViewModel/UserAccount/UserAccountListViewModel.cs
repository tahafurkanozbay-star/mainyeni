using Business._Base;
using Business.Core.Model;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountListViewModel : _BaseViewModel
    {
        public string UserName { get; set; }

        public string FirstName { get; set; }

        public string LastName { get; set; }
        public string Roles { get; internal set; }
        public UserAccountType AccountType { get; internal set; }
        public long CreateDate { get; internal set; }
    }
}