using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;

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
                    webBuilder
                        .UseStartup<Startup>()
                        .UseKestrel(options =>
                        {
                            // Keep framework defaults for request/connection limits unless a measured endpoint
                            // requires a narrower, explicitly documented override.
                            options.AddServerHeader = false;
                        });
                });
    }
}
