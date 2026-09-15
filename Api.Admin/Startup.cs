using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.OpenApi.Models;
using System.Text;
using Api.Admin.Filters;
using Business.Core.Context;
using System.IO;

namespace api.admin
{
    public class Startup
    {
        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
        }

        public IConfiguration Configuration { get; }

        // This method gets called by the runtime. Use this method to add services to the container.
        public void ConfigureServices(IServiceCollection services)
        {

            // ********************
            // Setup CORS
            // ********************
            var corsBuilder = new CorsPolicyBuilder();
            //corsBuilder.AllowAnyHeader();
            
            corsBuilder.WithHeaders("Authorization", "Accept", "Content-Type", "Connection", "Culture", "Referer", "User-Agent" ,"Origin", "origin");
            corsBuilder.WithMethods("GET","POST","PUT","OPTIONS");
            //corsBuilder.AllowAnyMethod();
            
            //TODO: Prod-Test
            corsBuilder.WithOrigins("http://localhost","http://localhost:3000","http://localhost:3001"); // for a specific url. Don't add a forward slash on the end!
            //corsBuilder.AllowAnyOrigin(); // For anyone access.

            corsBuilder.AllowCredentials();

            var policy = corsBuilder.Build();
            services.AddCors(options =>
            {
                options.AddPolicy("SiteCorsPolicy", policy);
            });

            /*
            var modules = Configuration.GetSection("Modules").GetChildren();
            foreach (var module in modules)
            {
                string moduleName = module.GetValue<string>("Name");
                System.Console.WriteLine("moduleName: " + moduleName);
            }
            */

            //Configure Db -- START
            var dbConfig = getDbConfig();
            string dbType = dbConfig.GetValue<string>("Type");
            string dbConnectionString = dbConfig.GetValue<string>("ConnectionString");

            if(dbType=="PGSQL"){
                services.AddDbContextPool<BusinessContext>(options => options.UseNpgsql(dbConnectionString));
                System.Console.WriteLine("PGSQL Connection: "+dbConnectionString);
            }
            else if(dbType=="MYSQL"){
                services.AddDbContextPool<BusinessContext>(options => options.UseMySql(dbConnectionString, ServerVersion.AutoDetect(dbConnectionString)));
                System.Console.WriteLine("MYSQL Connection: "+dbConnectionString);
            }
            //Configure Db -- END
            
            services.AddScoped<AdminRequestFilterAttribute>();
            services.AddControllers();
            services.AddMvc().SetCompatibilityVersion(CompatibilityVersion.Version_3_0);

            //swagger
            services.AddSwaggerGen(c =>
            {
                var filePath = "admin.api.xml";
                c.IncludeXmlComments(filePath);

                c.SwaggerDoc("CoreSwagger", new OpenApiInfo
                {
                    Title = "Ankara Kent Rehberi Admin API",
                    Version = "1.0.0",
                    Description = "Ankara Kent Rehberi Admin API v1",
                    Contact = new OpenApiContact()
                    {
                        Name = "Ankara Kent Rehberi Admin API .Net Core | Swagger Implementation",
                        Email = "proje@shkbilisim.com"
                    }
                });
            });

        }


        private IConfigurationSection getDbConfig(){

            var environment=Configuration.GetValue<string>("Environment");  
            IConfigurationSection dbConfig = null;
            
            System.Console.WriteLine("environment: "+environment);
            if(environment=="prod"){
                dbConfig =Configuration.GetSection("DbConfigProd");
            }
            else{
                dbConfig =Configuration.GetSection("DbConfigTest");
            }
             return dbConfig;
        }

        // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            //app.UseHttpsRedirection();

            if (env.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
            }

            app.UseForwardedHeaders(new ForwardedHeadersOptions
            {
                ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto
            });

            //app.UseOptions();
            app.UseCors("SiteCorsPolicy");
            app.UseRouting();

            app.UseAuthentication();

            app.UseAuthorization();

            //DATABASE CONFIGURATION
            var dbConfig = getDbConfig();
            bool recreateDatabase = dbConfig.GetValue<bool>("RecreateDatabase"); //Recreate database
            
            if (recreateDatabase)
            {
                using (var serviceScope = app.ApplicationServices.GetService<IServiceScopeFactory>().CreateScope())
                {
                    var context = serviceScope.ServiceProvider.GetRequiredService<BusinessContext>();
                    
                    context.Database.EnsureDeleted();
                    context.Database.EnsureCreated();
                    context.Database.Migrate();

                    //string script = context.Database.GenerateCreateScript();
                    //File.WriteAllText(@"/home/bekir/Documents/db-create-script.sql", script);
                }
            }

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllers();
            });


            app.UseExceptionHandler(errorApp =>
            {
                errorApp.Run(async context =>
                {
                    var errorFeature = context.Features.Get<IExceptionHandlerFeature>();
                    var exception = errorFeature.Error;

                    var problemDetails = new ProblemDetails
                    {
                        Title = "Hata",
                        Status = 500,
                        Detail =
                          $"{exception.Message} {exception.InnerException?.Message}"
                    };

                    context.Response.Headers.Add("Access-Control-Allow-Origin", "*");
                    context.Response.StatusCode = problemDetails.Status.GetValueOrDefault();
                    context.Response.Body.Write(Encoding.ASCII.GetBytes(problemDetails.ToString()));
                });
            });

            var environment = Configuration.GetValue<string>("Environment") ?? "test";
            if (environment=="test")
            {
                app.UseSwagger();
                app.UseSwaggerUI(options =>
                {
                    options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi User Api V1");
                });
            }

        }
    }
}