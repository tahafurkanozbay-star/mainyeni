using System;

namespace Toolbox.Security
{
    public class Base64Encryptor : IEncryptDecrypt
    {
        public string Decrypt(string EncryptedText, string key)
        {
            byte[] encoded = Convert.FromBase64String(EncryptedText);
            return System.Text.Encoding.UTF8.GetString(encoded);
        }

        public string Encrypt(string PlainText, string key)
        {
            byte[] encoded = System.Text.Encoding.UTF8.GetBytes(PlainText);
            return Convert.ToBase64String(encoded);
        }
    }
}