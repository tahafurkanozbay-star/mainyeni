using System.Collections.Generic;

namespace Business.Core.Resources
{
    public static class BusinessMessages
    {
        private static Dictionary<string,string[]> Messages=null;

        static BusinessMessages()
        {
                Messages=new Dictionary<string,string[]>(){

                    {"SUCCESS", new string[]{"Başarılı","Successful"}},
                    {"NOT_FOUND", new string[]{"Kayıt Bulunamadı","Record Not Found"}},
                    {"SAVED"    , new string[]{"Kaydedildi","Saved"}},
                    {"CREATED"    , new string[]{"Oluşturuldu","Created"}},
                    {"DELETED"  , new string[]{"Kayıt silindi","Deleted"}},
                    {"UPDATED"  , new string[]{"Kayıt güncellendi","Updated"}},
                    {"UPLOADED"  , new string[]{"Yüklendi","Uploaded"}},
                    {"NOT_AUTHORIZED", new string[]{"Kullanıcı yetkilendirilemedi","Not Authorized"}},
                    {"CANNOT_BE_CHANGED", new string[]{"Bu kayıt değiştirilemez","This record cannot be changed"}},
                    
                    {"INVALID_URL", new string[]{"Geçersiz bağlantı adresi","Invalid url"}},
                    
                };
        }

        public static string Get(string _message, string _culture="tr"){
            string[] val= Messages[_message];
            if(val!=null){
                return val[0];
            }
            return "";
        }


    }


}