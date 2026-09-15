using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using System;
using System.Security.Cryptography;
using System.Text;
using Toolbox.Security;
using Toolbox.Security.Password;

namespace Business.Core.Operations
{
    public class AuthPasswordOperations : _BaseOperations
    {
        private readonly BusinessContext db;

        public AuthPasswordOperations(BusinessContext context)
        {
            db = context;
        }

        public ServiceResult ValidatePassword(string password)
        {
            if (string.IsNullOrEmpty(password))
            {
                return new ServiceResult(ServiceResultType.Error, "Şifre boş olamaz");
            }

            if (password.Length < Configuration.MIN_PASSWORD_LENGTH)
            {
                return new ServiceResult(
                    ServiceResultType.Error,
                    "Şifre en az " + Configuration.MIN_PASSWORD_LENGTH + " karakter olmalıdır");
            }

            if (password.Length > Configuration.MAX_PASSWORD_LENGTH)
            {
                return new ServiceResult(
                    ServiceResultType.Error,
                    "Şifre en fazla " + Configuration.MAX_PASSWORD_LENGTH + " karakter olmalıdır");
            }

            return new ServiceResult(ServiceResultType.Success, "");
        }

        public string HashPassword(string password)
        {
            return PasswordUtils.HashPassword(password);
        }

        public bool VerifyPassword(string password, string storedHash, string legacySalt, out bool needsRehash)
        {
            needsRehash = false;
            if (string.IsNullOrEmpty(password) || string.IsNullOrWhiteSpace(storedHash))
            {
                return false;
            }

            if (PasswordUtils.IsModernHash(storedHash))
            {
                var valid = PasswordUtils.VerifyPassword(password, storedHash);
                needsRehash = valid && PasswordUtils.NeedsRehash(storedHash);
                return valid;
            }

            // Read-only legacy SHA-1 compatibility. Successful authentication immediately rehashes
            // to versioned PBKDF2 in AuthOperations.
            if (string.IsNullOrEmpty(legacySalt))
            {
                return false;
            }

            var legacyHash = PasswordUtils.Encrypt(password, legacySalt, new SHA1Encryptor());
            var expectedBytes = Encoding.UTF8.GetBytes(storedHash);
            var actualBytes = Encoding.UTF8.GetBytes(legacyHash);
            var validLegacy = expectedBytes.Length == actualBytes.Length &&
                              CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
            needsRehash = validLegacy;
            return validLegacy;
        }

        [Obsolete("Use HashPassword for new password writes; this method exists only for legacy compatibility.")]
        public string EncryptPassword(string password, string salt)
        {
            return PasswordUtils.Encrypt(password, salt, new SHA1Encryptor());
        }
    }
}
