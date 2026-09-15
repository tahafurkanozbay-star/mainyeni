using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;

namespace Toolbox.Date
{
    /// <summary>
    /// Bu sınıf metin işlemleri için çeşitli fonksiyonlar sunar
    /// </summary>
    public static class DateTimeUtils
    {
       
        public static long ToTimeStamp(DateTime value)
        {
            long epoch = (value.Ticks - 621355968000000000) / 10000000;
            return epoch;
        }

        public static DateTime ToDateTime(long timestamp)
        {
            DateTime result = DateTimeOffset.FromUnixTimeMilliseconds(timestamp/1000).DateTime;
            return result;
        }
    }
}