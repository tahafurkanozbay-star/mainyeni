using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace api.user
{
    public class Program
    {
        public static void Main(string[] args)
        {
            CreateHostBuilder(args).Build().Run();
        }

        public static IHostBuilder CreateHostBuilder(string[] args) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseStartup<Startup>().UseKestrel(o =>
                    {
                        o.Limits.KeepAliveTimeout = TimeSpan.FromMinutes(30);
                        o.Limits.MaxResponseBufferSize= 99999999;
                        o.AddServerHeader = false; //Kullanılan Teknoloji Bilgisinin Kısıtlanmaması güvenlik açığı çözümü 

                    });;
                });
    }
}
