using Api.Core.Platform;
using Api.User.Filters;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.OpenApi;

namespace api.user
{
    public class Startup
    {
        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
        }

        public IConfiguration Configuration { get; }

        public void ConfigureServices(IServiceCollection services)
        {
            services.AddKentRehberiApiPlatform(Configuration);
            services.AddScoped<AppRequestFilterAttribute>();
            services.AddMemoryCache();
            services.AddControllers();
            services.AddAuthorization();
            services.AddSwaggerGen(options =>
            {
                options.IncludeXmlComments("user.api.xml");
                options.SwaggerDoc("CoreSwagger", new OpenApiInfo
                {
                    Title = "Ankara Kent Rehberi User API",
                    Version = "1.0.0",
                    Description = "Ankara Kent Rehberi User API v1"
                });
            });
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            app.UseKentRehberiPlatformBeforeRouting();
            app.UseRouting();
            app.UseKentRehberiPlatformAfterRouting();
            app.UseAuthorization();

            var swaggerEnabled = Configuration.GetValue<bool>("Swagger:Enabled") || env.IsDevelopment();
            if (swaggerEnabled)
            {
                app.UseSwagger();
                app.UseSwaggerUI(options =>
                    options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi User API V1"));
            }

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapKentRehberiHealthChecks();
                endpoints.MapControllers();
            });
        }
    }
}
