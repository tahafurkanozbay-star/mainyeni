using Business._Base;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountResetPasswordChangeViewModel : _BaseViewModel
    {
        public string av { get; set; } //KeyA
        public string ky { get; set; } //KeyB
        public string tx { get; set; } //randomstr

        public string eg { get; set; } 
        public string password { get; set; } //yeni şifre
        public string passwordRepeat { get; set; } //yeni şifre tekrarı
    }
}
