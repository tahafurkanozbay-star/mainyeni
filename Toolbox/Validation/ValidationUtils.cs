using System;
using System.Net.Mail;

namespace Toolbox.Validation
{
    public static class ValidationUtils
    {
        /// <summary>
        /// Verilen emailAddress in geçerli olup olmadığını kontrol eder.
        /// </summary>
        public static bool ValidateEmail(string emailAddress)
        {
            if (string.IsNullOrWhiteSpace(emailAddress))
            {
                return false;
            }

            try
            {
                _ = new MailAddress(emailAddress);
                return true;
            }
            catch (FormatException)
            {
                return false;
            }
        }

        public static bool ValidateUrl(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            {
                return false;
            }

            return string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Verilen şifrenin geçerli olup olmadığını kontrol eder.
        /// </summary>
        public static bool ValidatePassword(
            string password,
            int minLength,
            int maxLength,
            bool mustHaveUpperCaseLetter,
            bool mustHaveLowerCaseLetter,
            bool mustHaveDecimalDigit)
        {
            if (password == null)
            {
                throw new ArgumentNullException(nameof(password));
            }
            if (minLength < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(minLength));
            }
            if (maxLength < minLength)
            {
                throw new ArgumentOutOfRangeException(nameof(maxLength));
            }

            var normalized = password.Trim();
            if (normalized.Length < minLength || normalized.Length > maxLength)
            {
                return false;
            }

            var hasUpperCaseLetter = false;
            var hasLowerCaseLetter = false;
            var hasDecimalDigit = false;

            foreach (var character in normalized)
            {
                if (char.IsUpper(character))
                {
                    hasUpperCaseLetter = true;
                }
                else if (char.IsLower(character))
                {
                    hasLowerCaseLetter = true;
                }
                else if (char.IsDigit(character))
                {
                    hasDecimalDigit = true;
                }
            }

            return (!mustHaveUpperCaseLetter || hasUpperCaseLetter) &&
                   (!mustHaveLowerCaseLetter || hasLowerCaseLetter) &&
                   (!mustHaveDecimalDigit || hasDecimalDigit);
        }
    }
}
