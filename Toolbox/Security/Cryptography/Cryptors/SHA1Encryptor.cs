using System;
using System.Security.Cryptography;
using System.Text;

namespace Toolbox.Security
{
    public class SHA1Encryptor : IEncryptDecrypt
    {
        //TODO: bu algoritma simetrik olmayabilir bu fonksiyon çalışmıyor
        public string Decrypt(string EncryptedText, string key)
        {
            throw new Exception("Cannot Decrypt SHA1");
        }

        public string Encrypt(string plainText, string key)
        {
            byte[] bytes = Encoding.Unicode.GetBytes(plainText);
            byte[] src = Encoding.Unicode.GetBytes(key);
            byte[] dst = new byte[src.Length + bytes.Length];
            Buffer.BlockCopy(src, 0, dst, 0, src.Length);
            Buffer.BlockCopy(bytes, 0, dst, src.Length, bytes.Length);
            HashAlgorithm algorithm = HashAlgorithm.Create("SHA1");
            byte[] inarray = algorithm.ComputeHash(dst);
            return Convert.ToBase64String(inarray);
        }
    }
}