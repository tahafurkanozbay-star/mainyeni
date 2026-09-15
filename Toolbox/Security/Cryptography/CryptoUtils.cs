using Toolbox;
using System;
using Toolbox.Text;

namespace Toolbox.Security.Cryptography
{
    /// <summary>
    /// Bu sınıf şifreleme işlemleri için çeşitli fonksiyonlar sunar
    /// </summary>
    public static class CryptoUtils
    {
        public static string EncryptDecrypt(IEncryptDecrypt encryption, CryptoMethod method, string plainText, string salt = "")
        {
            if (TextUtils.IsNullOrEmpty(salt))
                salt = SaltCreator.CreateRandomSalt();

            switch (method)
            {
                case CryptoMethod.ENCRYPT:
                    return encryption.Encrypt(plainText, salt);

                case CryptoMethod.DECRYPT:
                    return encryption.Decrypt(plainText, salt);

                default:
                    throw new Exception("Şifreleme metodu seçilmelidir (Encrypt / Decrypt)");
            }
        }

        public static String CreateRandomSalt(int digits=3)
        {
            Random rand = new Random();
            if (digits < 1)
            {
                digits = 1;
            }

            int coeff= (int)Math.Pow(10, digits-1);
            return rand.Next(1* coeff, 10* coeff - 1).ToString();
        }

        public static String CreateRandomString(int length=8)
        {
            var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            var stringChars = new char[length];
            var random = new Random();

            for (int i = 0; i < stringChars.Length; i++)
            {
                stringChars[i] = chars[random.Next(chars.Length)];
            }

            var finalString = new String(stringChars);
            return finalString;
        }
    }

    public enum CryptoMethod
    {
        ENCRYPT,
        DECRYPT
    }
}