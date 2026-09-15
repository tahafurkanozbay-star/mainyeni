using System;
using Toolbox.Security.Cryptography;

namespace Toolbox.Security.Url
{
    public static class ParameterEncryptionUtils
    {
        public static String EncryptGuid(Guid? guid, string salt="1234")
        {
           return EncryptGuid(guid.ToString(),salt);
        }

        public static String EncryptGuid(String guid, string salt="1234")
        {
            try
            {
                String encryptedGuid = CryptoUtils.EncryptDecrypt(new Base64Encryptor(), CryptoMethod.ENCRYPT, guid, salt);
                return encryptedGuid;
            }
            catch (Exception ex)
            {
                throw ex;
            }
        }


        public static Guid DecryptGuid(string encryptedGuid, string salt="1234")
        {
            try
            {
                String decryptedGuid = CryptoUtils.EncryptDecrypt(new Base64Encryptor(), CryptoMethod.DECRYPT, encryptedGuid, salt);
                return Guid.Parse(decryptedGuid);
            }
            catch (Exception ex)
            {
                throw ex;
            }
        }
    }
}