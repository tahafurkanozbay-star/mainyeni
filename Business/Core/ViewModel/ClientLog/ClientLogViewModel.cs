using Business._Base;
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;

namespace Business.Core.ViewModel
{

    public class ClientLogViewModel : _BaseViewModel
    {
        public string LogType { get; internal set; } //Log türü
        public string Details { get; set; } //Log detayı

        public string Username { get; set; }

        public string Browser { get; set; }
        public string Device { get; set; }
        public string Os { get; set; }
        public string Ip { get; set; }
    }

    public static class LogType{


        public static Tuple<string,int> GetById(int id)
        {
            Type type = typeof(LogType); // MyClass is static class with static properties

            var fields = type.GetFields();
           
            foreach (var p in fields)
            {
                var obj = (Tuple<String, int>)p.GetValue(null);


                if (obj.Item2==id)
                {
                    return obj;
                }
                
            }

            return null;
        }

        public static readonly Tuple<String, int> TEST_LOG = new Tuple<string, int>("Test Log", 0000);

        public static readonly Tuple<String, int> AUTH_LOGIN_SUCCESS = new Tuple<string, int>("Giriş-Başarılı", 1101);
        public static readonly Tuple<String, int> AUTH_LOGIN_FAIL = new Tuple<string, int>("Giriş-Başarısız", 1102);
        public static readonly Tuple<String, int> AUTH_LOGOUT = new Tuple<string, int>("Çıkış", 1103);
        public static readonly Tuple<String, int> AUTH_REGISTER_SUCCESS = new Tuple<string, int>("Kayıt-Başarılı", 2101);
        public static readonly Tuple<String, int> AUTH_REGISTER_FAIL = new Tuple<string, int>("Kayıt-Başarısız", 2102);
        
        public static readonly Tuple<String, int> AUTH_FORGOT_PASSWORD = new Tuple<string, int>("Şifremi Unuttum", 3101);
        public static readonly Tuple<String, int> AUTH_RESET_PASSWORD = new Tuple<string, int>("Şifre sıfırlama", 3102);
        public static readonly Tuple<String, int> AUTH_CHANGE_PASSWORD = new Tuple<string, int>("Şifre değişikliği", 3103);
        
        public static readonly Tuple<String, int> AUTH_FORGOT_PASSWORD_VERIFY_PARAMS = new Tuple<string, int>("Şifremi Unuttum - Parametre Doğrulama", 3104);
        public static readonly Tuple<String, int> AUTH_FORGOT_PASSWORD_VERIFY_PARAMS_SUCCESS = new Tuple<string, int>("Şifremi Unuttum - Parametre Doğrulama - Başarılı", 3105);
        public static readonly Tuple<String, int> AUTH_FORGOT_PASSWORD_VERIFY_PARAMS_FAIL = new Tuple<string, int>("Şifremi Unuttum - Parametre Doğrulama - Başarısız", 3106);
        public static readonly Tuple<String, int> AUTH_FORGOT_PASSWORD_CHANGE_PASSWORD = new Tuple<string, int>("Şifremi Unuttum - Şifre Değiştirme", 3107);
        

        public static readonly Tuple<String, int> AUTH_ACCOUNT_ACTIVATION_VERIFY_PARAMS = new Tuple<string, int>("Hesap Aktivasyonu - Parametre Doğrulama", 3201);
        public static readonly Tuple<String, int> AUTH_ACCOUNT_ACTIVATION_VERIFY_PARAMS_SUCCESS = new Tuple<string, int>("Hesap Aktivasyonu - Parametre Doğrulama - Başarılı", 3202);
        public static readonly Tuple<String, int> AUTH_ACCOUNT_ACTIVATION_VERIFY_PARAMS_FAIL = new Tuple<string, int>("Hesap Aktivasyonu - Parametre Doğrulama - Başarısız", 3203);


        public static readonly Tuple<String, int> AUTH_ACCOUNT_CLOSE_VERIFY_PARAMS = new Tuple<string, int>("Hesap Kapatma - Parametre Doğrulama", 3101);
        public static readonly Tuple<String, int> AUTH_ACCOUNT_CLOSE_VERIFY_PARAMS_SUCCESS = new Tuple<string, int>("Hesap Kapatma - Parametre Doğrulama - Başarılı", 3302);
        public static readonly Tuple<String, int> AUTH_ACCOUNT_CLOSE_VERIFY_PARAMS_FAIL = new Tuple<string, int>("Hesap Kapatma - Parametre Doğrulama - Başarısız", 3303);


        public static readonly Tuple<String, int> ITEM_SHARE = new Tuple<string, int>("İçerik paylaşımı", 5201);
        public static readonly Tuple<String, int> ITEM_VIEW = new Tuple<string, int>("İçerik görüntüleme", 5202);
        public static readonly Tuple<String, int> ITEM_SEARCH = new Tuple<string, int>("İçerik arama", 5203);
        public static readonly Tuple<String, int> ITEM_FAVORITE_ADD = new Tuple<string, int>("İçerik beğen", 5204);
        public static readonly Tuple<String, int> ITEM_FAVORITE_REMOVE = new Tuple<string, int>("İçerik beğeniden çıkar", 5205);
        
        public static readonly Tuple<String, int> DOCUMENT_CREATE = new Tuple<string, int>("Doküman oluşturma", 6301);
        public static readonly Tuple<String, int> DOCUMENT_DOWNLOAD = new Tuple<string, int>("Doküman indirme", 6302);
        public static readonly Tuple<String, int> DOCUMENT_DELETE = new Tuple<string, int>("Doküman silme", 6303);


        public static readonly Tuple<String, int> OCR_PROCESS_START = new Tuple<string, int>("OCR İşlemi Başlangıcı", 7101);
        public static readonly Tuple<String, int> OCR_PROCESS_SUCCESS = new Tuple<string, int>("OCR İşlemi Tamamlandı - Başarılı", 7302);
        public static readonly Tuple<String, int> OCR_PROCESS_FAIL = new Tuple<string, int>("OCR İşlemi Tamamlandı - Başarısız", 7303);


    } 
}
