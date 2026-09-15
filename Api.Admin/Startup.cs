using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.OpenApi.Models;
using System.Text.Json;
using Api.Admin.Filters;
using Business.Core.Context;
using System.Linq;

namespace api.admin
{
    public class Startup
    {
        public Startup(IConfiguration configuration) { Configuration = configuration; }
        public IConfiguration Configuration { get; }

        public void ConfigureServices(IServiceCollection services)
        {
            var configuredOrigins = Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? new string[0];
            var corsBuilder = new CorsPolicyBuilder()
                .WithOrigins(configuredOrigins)
                .WithHeaders("Authorization", "Accept", "Content-Type", "Connection", "Culture", "Referer", "User-Agent", "Origin")
                .WithMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .AllowCredentials();
            services.AddCors(options => options.AddPolicy("SiteCorsPolicy", corsBuilder.Build()));

            var dbConfig = getDbConfig();
            var dbType = dbConfig.GetValue<string>("Type");
            var dbConnectionString = dbConfig.GetValue<string>("ConnectionString");
            if (string.IsNullOrWhiteSpace(dbConnectionString))
                throw new InvalidOperationException("Database connection string is missing. Configure it via environment-specific settings or secret storage.");

            if (dbType == "PGSQL") services.AddDbContextPool<BusinessContext>(options => options.UseNpgsql(dbConnectionString));
            else if (dbType == "MYSQL") services.AddDbContextPool<BusinessContext>(options => options.UseMySql(dbConnectionString, ServerVersion.AutoDetect(dbConnectionString)));
            else throw new InvalidOperationException($"Unsupported database type: {dbType}");

            services.AddScoped<AdminRequestFilterAttribute>();
            services.AddControllers();
            services.AddMvc().SetCompatibilityVersion(CompatibilityVersion.Version_3_0);
            services.AddSwaggerGen(c =>
            {
                c.IncludeXmlComments("admin.api.xml");
                c.SwaggerDoc("CoreSwagger", new OpenApiInfo { Title = "Ankara Kent Rehberi Admin API", Version = "1.0.0" });
            });
        }

        private IConfigurationSection getDbConfig()
        {
            var environment = Configuration.GetValue<string>("Environment") ?? "test";
            return Configuration.GetSection(environment == "prod" ? "DbConfigProd" : "DbConfigTest");
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
            {
                context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                context.Response.ContentType = "application/problem+json";
                var payload = JsonSerializer.Serialize(new { title = "Hata", status = 500, traceId = context.TraceIdentifier });
                await context.Response.WriteAsync(payload);
            }));

            app.UseForwardedHeaders(new Microsoft.AspNetCore.HttpOverrides.ForwardedHeadersOptions
            {
                ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto
            });
            app.Use(async (context, next) =>
            {
                context.Response.Headers["X-Content-Type-Options"] = "nosniff";
                context.Response.Headers["X-Frame-Options"] = "DENY";
                context.Response.Headers["Referrer-Policy"] = "no-referrer";
                context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
                await next();
            });
            app.UseCors("SiteCorsPolicy");
            app.UseRouting();
            app.UseAuthentication();
            app.UseAuthorization();

            var recreateDatabase = getDbConfig().GetValue<bool>("RecreateDatabase");
            if (recreateDatabase && env.IsDevelopment())
            {
                using var scope = app.ApplicationServices.GetRequiredService<IServiceScopeFactory>().CreateScope();
                var context = scope.ServiceProvider.GetRequiredService<BusinessContext>();
                context.Database.Migrate();
            }

            app.UseEndpoints(endpoints => endpoints.MapControllers());

            if ((Configuration.GetValue<string>("Environment") ?? "test") == "test")
            {
                app.UseSwagger();
                app.UseSwaggerUI(options => options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi Admin API v1"));
            }
        }
    }
}
