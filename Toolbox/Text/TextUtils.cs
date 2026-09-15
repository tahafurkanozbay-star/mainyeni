using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;

namespace Toolbox.Text
{
    /// <summary>
    /// Bu sınıf metin işlemleri için çeşitli fonksiyonlar sunar
    /// </summary>
    public static class TextUtils
    {
        /// <summary>
        /// Verilen metnin baş harfini büyük harfe, diğerlerini ise küçük harfe çevirir
        /// </summary>
        /// <param name="text">Çevirilecek metin</param>
        /// <returns>String</returns>
        public static String Capitalize(String text)
        {
            CultureInfo cultureInfo = Thread.CurrentThread.CurrentCulture;
            TextInfo textInfo = cultureInfo.TextInfo;
            return textInfo.ToTitleCase(text.ToLower());
        }

        /// <summary>
        /// Verilen bir metnin boş ya da null olup olmadığını kontrol eder
        /// </summary>
        /// <param name="text">Kontrol edilecek metin</param>
        /// <returns>boolean</returns>
        public static bool IsNullOrEmpty(String text)
        {
            bool isNullOrEmpty = false;

            if (text == null)
            {
                isNullOrEmpty = true;
            }
            else
            {
                if (text == "")
                {
                    isNullOrEmpty = true;
                }

                if (text.Trim().Length == 0)
                {
                    isNullOrEmpty = true;
                }

                if (text.ToLower().Trim() == "null")
                {
                    isNullOrEmpty = true;
                }
            }
            return isNullOrEmpty;
        }

        public static string ReplaceNullValue(string text, bool returnEmptyText)
        {
            string returnText = null;

            if (IsNullOrEmpty(text))
            {
                text = null;
                if (returnEmptyText)
                {
                    returnText = "";
                }
            }
            else
            {
                returnText = text;
            }

            return returnText;
        }

        public static string RemoveTurkishChars(string str)
        {
            //TODO: küçük ı dönüştürülemiyor
            return str.Replace("Ç", "C").Replace("ç", "c")
                .Replace("İ", "I").Replace("ı", "i")
                .Replace("Ş", "S").Replace("ş", "s")
                .Replace("Ğ", "G").Replace("ğ", "g")
                .Replace("Ö", "O").Replace("ö", "o")
                .Replace("Ü", "U").Replace("ü", "u");
        }

        public static string DeConvertFromHtml(string text)
        {
            return System.Web.HttpUtility.HtmlEncode(text);
        }

        public static string ConvertToHtml(string htmlText)
        {
            return System.Web.HttpUtility.HtmlDecode(htmlText);
        }

        public static string CleanString(string dirtyString)
        {
            if (String.IsNullOrEmpty(dirtyString))
            {
                return "";
            }

            HashSet<char> removeChars = new HashSet<char>(" %?&^$#!()+-,:;<>’\'-_*");
            StringBuilder result = new StringBuilder(dirtyString.Length);
            foreach (char c in dirtyString)
                if (!removeChars.Contains(c)) // prevent dirty chars
                    result.Append(c);
            return result.ToString();
        }
    }
}