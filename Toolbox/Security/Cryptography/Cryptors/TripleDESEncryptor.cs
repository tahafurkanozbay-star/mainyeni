using System;
using System.IO;
using System.Security.Cryptography;

namespace Toolbox.Security
{
    public class TripleDESEncryptor : IEncryptDecrypt
    {
        private string fPassword = "ABC";
        private byte[] fSalt;

        private byte[] iEncrypt(byte[] data, byte[] key, byte[] iv)
        {
            MemoryStream ms = new MemoryStream();
            TripleDES alg = TripleDES.Create();

            alg.Key = key;
            alg.IV = iv;

            CryptoStream cs = new CryptoStream(ms, alg.CreateEncryptor(), CryptoStreamMode.Write);

            cs.Write(data, 0, data.Length);
            cs.Close();
            return ms.ToArray();
        }

        private byte[] GetBytes(string str)
        {
            byte[] bytes = new byte[str.Length * sizeof(char)];
            System.Buffer.BlockCopy(str.ToCharArray(), 0, bytes, 0, bytes.Length);
            return bytes;
        }

        private string GetString(byte[] bytes)
        {
            char[] chars = new char[bytes.Length / sizeof(char)];
            System.Buffer.BlockCopy(bytes, 0, chars, 0, bytes.Length);
            return new string(chars);
        }

        /// <summary>
        /// Encrypt string with TripleDES algorith.
        /// </summary>
        /// <param name="plainText">String to encrypt.</param>
        /// <returns>Encrypted string.</returns>
        public string Encrypt(string plainText, string key)
        {
            byte[] dataToEncrypt = System.Text.Encoding.Unicode.GetBytes(plainText);
            PasswordDeriveBytes pdb = new PasswordDeriveBytes(fPassword, GetBytes(key));

            return Convert.ToBase64String(iEncrypt(dataToEncrypt, pdb.GetBytes(16), pdb.GetBytes(8)));
        }

        /// <summary>
        /// Encrypt byte array with TripleDES algorithm.
        /// </summary>
        /// <param name="data">Bytes to encrypt.</param>
        /// <returns>Encrypted bytes.</returns>
        private byte[] Encrypt(byte[] data)
        {
            PasswordDeriveBytes pdb = new PasswordDeriveBytes(fPassword, fSalt);
            return iEncrypt(data, pdb.GetBytes(16), pdb.GetBytes(8));
        }

        private byte[] iDecrypt(byte[] data, byte[] key, byte[] iv)
        {
            MemoryStream ms = new MemoryStream();
            TripleDES alg = TripleDES.Create();

            alg.Key = key;
            alg.IV = iv;

            CryptoStream cs = new CryptoStream(ms, alg.CreateDecryptor(), CryptoStreamMode.Write);
            cs.Write(data, 0, data.Length);
            cs.Close();

            return ms.ToArray();
        }

        /// <summary>
        /// Decrypt string with TripleDES algorithm.
        /// </summary>
        /// <param name="encryptedText">Encrypted string.</param>
        /// <returns>Decrypted string.</returns>
        public string Decrypt(string encryptedText, string key)
        {
            byte[] cipherBytes = Convert.FromBase64String(encryptedText);
            PasswordDeriveBytes pdb = new PasswordDeriveBytes(fPassword, GetBytes(key));
            return System.Text.Encoding.Unicode.GetString(iDecrypt(cipherBytes, pdb.GetBytes(16), pdb.GetBytes(8)));
        }
    }
}