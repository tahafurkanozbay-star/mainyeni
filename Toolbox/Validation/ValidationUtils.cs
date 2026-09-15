using System;
using System.Net.Mail;

namespace Toolbox.Validation
{
    public static class ValidationUtils
    {
        /// <summary>
        /// Verilen emailAddress in geçerli olup olmadığını kontrol eder
        /// </summary>
        /// <param name="emailAddress">Geçerlenecek email adresi</param>
        /// <returns>true ya da false döndürür</returns>
        public static bool ValidateEmail(String emailAddress)
        {
            try
            {
                //TODO: bekir@as geçiyor, düşünülmeli
                MailAddress m = new MailAddress(emailAddress);
                return true;
            }
            catch (FormatException)
            {
                return false;
            }
        }

        public static bool ValidateUrl(String url)
        {
            if (Uri.IsWellFormedUriString(url, UriKind.Absolute))
            {
                return true;
            }
            else
            {
                return false;
            }
        }

        /// <summary>
        /// Verilen şifrenin geçerli olup olmadığını kontrol eder
        /// </summary>
        /// <param name="password">şifre açık metni</param>
        /// <param name="minLength">en küçük şifre uzunluğu</param>
        /// <param name="maxLength">en büyük şifre uzunluğu</param>
        /// <returns>true ya da false döndürür</returns>
        public static bool ValidatePassword(string password, int minLength,
         int maxLength, bool mustHaveUpperCaseLetter,
          bool mustHaveLowerCaseLetter, bool mustHaveDecimalDigit)
        {
            bool isValid = false;

            try
            {
                if (password == null) throw new ArgumentNullException();

                //Remove unexpected spaces
                password = password.Trim();
                bool meetsLengthRequirements = password.Length >= minLength && password.Length <= maxLength;
                bool hasUpperCaseLetter = false;
                bool hasLowerCaseLetter = false;
                bool hasDecimalDigit = false;

                if (meetsLengthRequirements)
                {
                    foreach (char c in password)
                    {
                        if (char.IsUpper(c)) hasUpperCaseLetter = true;
                        else if (char.IsLower(c)) hasLowerCaseLetter = true;
                        else if (char.IsDigit(c)) hasDecimalDigit = true;
                    }
                }

                bool upperCaseValidation = false;
                bool lowerCaseValidation = false;
                bool decimalValidation = false;

                if (!hasUpperCaseLetter && mustHaveUpperCaseLetter) { upperCaseValidation = false; } else { upperCaseValidation = true; }
                if (!hasLowerCaseLetter && mustHaveLowerCaseLetter) { lowerCaseValidation = false; } else { lowerCaseValidation = true; }
                if (!hasDecimalDigit && mustHaveDecimalDigit) { decimalValidation = false; } else { decimalValidation = true; }

                //Last check
                isValid = meetsLengthRequirements && upperCaseValidation && lowerCaseValidation && decimalValidation;
            }
            catch (Exception ex)
            {
                throw ex;
            }

            return isValid;
        }
    }
}