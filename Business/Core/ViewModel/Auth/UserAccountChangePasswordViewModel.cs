using Business._Base;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountChangePasswordViewModel : _BaseViewModel
    {
        public string OldPassword { get; set; }
        public string NewPassword { get; set; }
        public string NewPasswordRepeat { get; set; }
    }
}
