using System;
using Toolbox.Security.Cryptography;

namespace Toolbox.Security.Url
{
    /// <summary>
    /// Legacy URL identifier encoding. This is reversible Base64 compatibility encoding and is
    /// not an authorization or confidentiality boundary.
    /// </summary>
    public static class ParameterEncryptionUtils
    {
        public static string EncryptGuid(Guid? guid, string salt = "1234")
        {
            if (!guid.HasValue)
            {
                throw new ArgumentNullException(nameof(guid));
            }

            return EncryptGuid(guid.Value.ToString(), salt);
        }

        public static string EncryptGuid(string guid, string salt = "1234")
        {
            if (string.IsNullOrWhiteSpace(guid))
            {
                throw new ArgumentException("A GUID value is required.", nameof(guid));
            }

            if (!Guid.TryParse(guid, out var parsed))
            {
                throw new FormatException("The supplied value is not a valid GUID.");
            }

            return CryptoUtils.EncryptDecrypt(
                new Base64Encryptor(),
                CryptoMethod.ENCRYPT,
                parsed.ToString(),
                salt);
        }

        public static Guid DecryptGuid(string encryptedGuid, string salt = "1234")
        {
            if (string.IsNullOrWhiteSpace(encryptedGuid))
            {
                throw new ArgumentException("An encoded GUID value is required.", nameof(encryptedGuid));
            }

            var decryptedGuid = CryptoUtils.EncryptDecrypt(
                new Base64Encryptor(),
                CryptoMethod.DECRYPT,
                encryptedGuid,
                salt);

            if (!Guid.TryParse(decryptedGuid, out var guid))
            {
                throw new FormatException("The encoded value does not contain a valid GUID.");
            }

            return guid;
        }
    }
}
