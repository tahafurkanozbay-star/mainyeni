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
using Api.User.Filters;
using Business.Core.Context;
using System;
using System.Linq;

namespace api.user
{
    public class Startup
    {
        public Startup(IConfiguration configuration) { Configuration = configuration; }
        public IConfiguration Configuration { get; }

        public void ConfigureServices(IServiceCollection services)
        {
            ConfigureCors(services);
            ConfigureDatabase(services);
            services.AddScoped<AppRequestFilterAttribute>();
            services.AddMemoryCache();
            services.AddControllers();
            services.AddMvc().SetCompatibilityVersion(CompatibilityVersion.Version_3_0);
            services.AddSwaggerGen(c =>
            {
                c.IncludeXmlComments("user.api.xml");
                c.SwaggerDoc("CoreSwagger", new OpenApiInfo
                {
                    Title = "Ankara Kent Rehberi User API",
                    Version = "1.0.0",
                    Description = "Ankara Kent Rehberi User API v1"
                });
            });
        }

        private void ConfigureCors(IServiceCollection services)
        {
            var origins = Configuration.GetSection("Cors:AllowedOrigins")
                .GetChildren()
                .Select(x => x.Value)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.TrimEnd('/'))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            services.AddCors(options => options.AddPolicy("SiteCorsPolicy", policy =>
            {
                policy.WithMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                    .WithHeaders("Authorization", "Accept", "Content-Type", "Connection", "Culture", "Referer", "Origin", "User-Agent");
                if (origins.Length > 0) policy.WithOrigins(origins).AllowCredentials();
            }));
        }

        private void ConfigureDatabase(IServiceCollection services)
        {
            var db = GetDbConfig();
            var type = db.GetValue<string>("Type")?.Trim().ToUpperInvariant();
            var connection = db.GetValue<string>("ConnectionString")?.Trim();
            if (string.IsNullOrWhiteSpace(connection))
                throw new InvalidOperationException("Database connection string is not configured on the server.");

            if (type == "PGSQL")
            {
                services.AddDbContextPool<BusinessContext>(o => o.UseNpgsql(connection));
                return;
            }
            if (type == "MYSQL")
            {
                services.AddDbContextPool<BusinessContext>(o => o.UseMySql(connection, ServerVersion.AutoDetect(connection)));
                return;
            }
            throw new InvalidOperationException($"Unsupported database type: {type ?? "<missing>"}");
        }

        private IConfigurationSection GetDbConfig()
        {
            var environment = Configuration.GetValue<string>("Environment")?.Trim().ToLowerInvariant();
            return environment == "prod" ? Configuration.GetSection("DbConfigProd") : Configuration.GetSection("DbConfigTest");
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            app.UseForwardedHeaders(new ForwardedHeadersOptions
            {
                ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
            });

            app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
            {
                var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
                var logger = context.RequestServices.GetRequiredService<Microsoft.Extensions.Logging.ILogger<Startup>>();
                logger.LogError(exception, "Unhandled user API exception. TraceId: {TraceId}", context.TraceIdentifier);
                context.Response.StatusCode = 500;
                context.Response.ContentType = "application/problem+json";
                await context.Response.WriteAsJsonAsync(new
                {
                    type = "about:blank",
                    title = "Internal Server Error",
                    status = 500,
                    traceId = context.TraceIdentifier
                });
            }));

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
                app.UseSwaggerUI(options => options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi User API V1"));
            }

            app.UseEndpoints(endpoints => endpoints.MapControllers());
        }
    }
}
