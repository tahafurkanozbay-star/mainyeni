using Api.Admin.Filters;
using Api.Core.Platform;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.OpenApi;

namespace api.admin
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
            // CORS allowlists are resolved centrally by AddKentRehberiApiPlatform from
            // Platform:Cors:AllowedOrigins and the temporary legacy Cors:AllowedOrigins bridge.
            services.AddKentRehberiApiPlatform(Configuration);
            services.AddScoped<AdminRequestFilterAttribute>();
            services.AddControllers();
            services.AddAuthorization();
            services.AddSwaggerGen(options =>
            {
                options.IncludeXmlComments("admin.api.xml");
                options.SwaggerDoc("CoreSwagger", new OpenApiInfo
                {
                    Title = "Ankara Kent Rehberi Admin API",
                    Version = "1.0.0",
                    Description = "Ankara Kent Rehberi Admin API v1"
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
                    options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi Admin API V1"));
            }

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapKentRehberiHealthChecks();
                endpoints.MapControllers();
            });
        }
    }
}
