using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;

namespace Services.Middleware
{
    public class OptionsMiddleware
    {
        private readonly RequestDelegate _next;

        public OptionsMiddleware(RequestDelegate next)
        {
            _next = next;
        }

        public Task Invoke(HttpContext context)
        {
            return BeginInvoke(context);
        }

        private Task BeginInvoke(HttpContext context)
        {
            if (context.Request.Method == "OPTIONS")
            {
                context.Response.Headers.Add("Dev-Server", "true");
                context.Response.Headers.Add("X-Content-Type-Options", "nosniff"); //4.12.2.5 XSS (Content-Sniffing) Saldırılarına Karşı Koruma Eksikliği güvenlik açığı çözümü
                context.Response.Headers.Add("X-XSS-Protection", "1;mode=block"); //4.12.2.7 Eski Web Tarayıcılarda XSS Saldırılarına Karşı Koruma Eksikliği güvenlik açığı çözümü
                context.Response.Headers.Add("X-Frame-Options", "SAMEORIGIN");
                context.Response.Headers.Add("Strict-Transport-Security", "max-age=31536000");
                context.Response.Headers.Add("Access-Control-Allow-Origin", "http://localhost,http://localhost:3000,http://localhost:3001");
                context.Response.Headers.Add("Access-Control-Allow-Headers", new[] { "Origin, X-Requested-With, Content-Type, Accept, Authorization" });
                context.Response.Headers.Add("Access-Control-Allow-Methods", new[] { "GET, POST, PUT, DELETE, OPTIONS" });
                context.Response.Headers.Add("Access-Control-Allow-Credentials", new[] { "true" });
                context.Response.StatusCode = 200;
                return context.Response.WriteAsync("OK");
            }

            return _next.Invoke(context);
        }
    }

    public static class OptionsMiddlewareExtensions
    {
        public static IApplicationBuilder UseOptions(this IApplicationBuilder builder)
        {
            return builder.UseMiddleware<OptionsMiddleware>();
        }
    }
}