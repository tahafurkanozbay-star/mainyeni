using System;
using System.Text.RegularExpressions;
using Toolbox.Security.Cryptography;

namespace Toolbox.Security.Password
{
    public static class PasswordUtils
    {
        public static String Encrypt(string password, string salt, IEncryptDecrypt encryption)
        {
            return CryptoUtils.EncryptDecrypt(encryption, CryptoMethod.ENCRYPT, password, salt);
        }

        public static String Decrypt(string password, string salt, IEncryptDecrypt encryption)
        {
            return CryptoUtils.EncryptDecrypt(encryption, CryptoMethod.DECRYPT, password, salt);
        }

        /// <summary>
        /// Verilen şifrenin güçlülük durumunu hesaplar
        /// </summary>
        /// <param name="password">Hesaplanacak şifrenin açık hali</param>
        /// <returns></returns>
        public static PasswordScore EvaluatePasswordStrength(string password)
        {
            int score = 1;

            if (password.Length < 1)
                return PasswordScore.Blank;
            if (password.Length < 4)
                return PasswordScore.VeryWeak;
            if (password.Length >= 8)
                score++;
            if (password.Length >= 12)
                score++;
            if (Regex.Match(password, @"/\d+/", RegexOptions.ECMAScript).Success)
                score++;
            if (Regex.Match(password, @"/[a-z]/", RegexOptions.ECMAScript).Success &&
              Regex.Match(password, @"/[A-Z]/", RegexOptions.ECMAScript).Success)
                score++;
            if (Regex.Match(password, @"/.[!,@,#,$,%,^,&,*,?,_,~,-,£,(,)]/", RegexOptions.ECMAScript).Success)
                score++;

            return (PasswordScore)score;
        }

        public enum PasswordScore
        {
            Blank = 0,
            VeryWeak = 1,
            Weak = 2,
            Medium = 3,
            Strong = 4,
            VeryStrong = 5
        }
    }
}