using Business._Base;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountLoginViewModel : _BaseViewModel
    {
        public string UserName { get; set; }
        public string Password { get; set; }
    }
}
