using Api.Admin.Filters;
using Api.Core.Platform;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.OpenApi;

namespace api.admin;

public static class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;
        });

        // CORS allowlists are resolved centrally by AddKentRehberiApiPlatform from
        // Platform:Cors:AllowedOrigins and the temporary legacy Cors:AllowedOrigins bridge.
        builder.Services.AddKentRehberiApiPlatform(builder.Configuration);
        builder.Services.AddScoped<AdminRequestFilterAttribute>();
        builder.Services.AddControllers();
        builder.Services.AddAuthorization();
        builder.Services.AddSwaggerGen(options =>
        {
            options.IncludeXmlComments("admin.api.xml");
            options.SwaggerDoc("CoreSwagger", new OpenApiInfo
            {
                Title = "Ankara Kent Rehberi Admin API",
                Version = "1.0.0",
                Description = "Ankara Kent Rehberi Admin API v1"
            });
        });

        var app = builder.Build();

        app.UseKentRehberiPlatformBeforeRouting();
        app.UseRouting();
        app.UseKentRehberiPlatformAfterRouting();
        app.UseAuthorization();

        var swaggerEnabled = builder.Configuration.GetValue<bool>("Swagger:Enabled") ||
                             app.Environment.IsDevelopment();
        if (swaggerEnabled)
        {
            app.UseSwagger();
            app.UseSwaggerUI(options =>
                options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi Admin API V1"));
        }

        app.MapKentRehberiHealthChecks();
        app.MapControllers();

        app.Run();
    }
}
