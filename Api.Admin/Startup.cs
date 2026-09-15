using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.OpenApi.Models;
using Api.Admin.Filters;
using Business.Core.Context;
using System;
using System.Linq;

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
            ConfigureCors(services);
            ConfigureDatabase(services);

            services.AddScoped<AdminRequestFilterAttribute>();
            services.AddControllers();
            services.AddMvc().SetCompatibilityVersion(CompatibilityVersion.Version_3_0);

            services.AddSwaggerGen(c =>
            {
                c.IncludeXmlComments("admin.api.xml");
                c.SwaggerDoc("CoreSwagger", new OpenApiInfo
                {
                    Title = "Ankara Kent Rehberi Admin API",
                    Version = "1.0.0",
                    Description = "Ankara Kent Rehberi Admin API v1"
                });
            });
        }

        private void ConfigureCors(IServiceCollection services)
        {
            var origins = Configuration
                .GetSection("Cors:AllowedOrigins")
                .GetChildren()
                .Select(section => section.Value)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value.TrimEnd('/'))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            services.AddCors(options =>
            {
                options.AddPolicy("SiteCorsPolicy", policy =>
                {
                    policy.WithMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                        .WithHeaders("Authorization", "Accept", "Content-Type", "Connection", "Culture", "Referer", "Origin", "User-Agent");

                    if (origins.Length > 0)
                    {
                        policy.WithOrigins(origins).AllowCredentials();
                    }
                });
            });
        }

        private void ConfigureDatabase(IServiceCollection services)
        {
            var dbConfig = GetDbConfig();
            var dbType = dbConfig.GetValue<string>("Type")?.Trim().ToUpperInvariant();
            var connectionString = dbConfig.GetValue<string>("ConnectionString")?.Trim();

            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException(
                    "Database connection string is not configured. Supply the selected environment connection string through the server environment or secret store.");
            }

            if (dbType == "PGSQL")
            {
                services.AddDbContextPool<BusinessContext>(options => options.UseNpgsql(connectionString));
                return;
            }

            if (dbType == "MYSQL")
            {
                services.AddDbContextPool<BusinessContext>(options => options.UseMySql(
                    connectionString,
                    ServerVersion.AutoDetect(connectionString)));
                return;
            }

            throw new InvalidOperationException($"Unsupported database type: {dbType ?? "<missing>"}");
        }

        private IConfigurationSection GetDbConfig()
        {
            var environment = Configuration.GetValue<string>("Environment")?.Trim().ToLowerInvariant();
            return environment == "prod"
                ? Configuration.GetSection("DbConfigProd")
                : Configuration.GetSection("DbConfigTest");
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            app.UseForwardedHeaders(new ForwardedHeadersOptions
            {
                ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
            });

            app.UseExceptionHandler(errorApp =>
            {
                errorApp.Run(async context =>
                {
                    var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
                    var logger = context.RequestServices.GetRequiredService<Microsoft.Extensions.Logging.ILogger<Startup>>();
                    logger.LogError(exception, "Unhandled admin API exception. TraceId: {TraceId}", context.TraceIdentifier);

                    context.Response.StatusCode = 500;
                    context.Response.ContentType = "application/problem+json";
                    await context.Response.WriteAsJsonAsync(new
                    {
                        type = "about:blank",
                        title = "Internal Server Error",
                        status = 500,
                        traceId = context.TraceIdentifier
                    });
                });
            });

            app.UseRouting();
            app.UseCors("SiteCorsPolicy");
            app.UseAuthentication();
            app.UseAuthorization();

            app.Use(async (context, next) =>
            {
                context.Response.Headers["X-Content-Type-Options"] = "nosniff";
                context.Response.Headers["Referrer-Policy"] = "no-referrer";
                context.Response.Headers["X-Frame-Options"] = "DENY";
                await next();
            });

            var environment = Configuration.GetValue<string>("Environment") ?? "test";
            if (env.IsDevelopment() || string.Equals(environment, "test", StringComparison.OrdinalIgnoreCase))
            {
                app.UseSwagger();
                app.UseSwaggerUI(options =>
                {
                    options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi Admin API V1");
                });
            }

            var recreateDatabase = GetDbConfig().GetValue<bool>("RecreateDatabase");
            if (recreateDatabase && env.IsDevelopment())
            {
                using (var serviceScope = app.ApplicationServices.GetService<IServiceScopeFactory>().CreateScope())
                {
                    var context = serviceScope.ServiceProvider.GetRequiredService<BusinessContext>();
                    context.Database.EnsureDeleted();
                    context.Database.EnsureCreated();
                    context.Database.Migrate();
                }
            }

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllers();
            });
        }
    }
}
