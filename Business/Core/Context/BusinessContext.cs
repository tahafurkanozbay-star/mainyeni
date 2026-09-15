using System;
using System.Collections.Generic;
using Business.Core.Common;
using Business.Core.Model;
using Business.Core.Operations;
using Microsoft.EntityFrameworkCore;
using Toolbox.Security.Cryptography;

namespace Business.Core.Context
{
    public partial class BusinessContext : DbContext
    {
        public DbSet<AppConfig> AppConfigs { get; set; }

        public DbSet<BusinessException> BusinessExceptions { get; set; }

        public DbSet<ClientLog> ClientLogs { get; set; } //Client logları

        public DbSet<UserAccount> UserAccounts { get; set; } //Kullanıcı hesapları

        public DbSet<UserRole> UserRoles { get; set; } //Kullanıcı rolleri

        public DbSet<UserRoleRegistration> UserRoleRegistrations { get; set; } //Kullanıcılara ait roller

        public BusinessContext(DbContextOptions<BusinessContext> _options)
            : base(_options)
        {
        }


        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.HasDefaultSchema(Configuration.SCHEMA_NAME);
            
            createData(modelBuilder);

            base.OnModelCreating(modelBuilder);
        }



        protected void createData(ModelBuilder modelBuilder)
        {
            
            //create admin role
            var role = new UserRole()
            {
                Id = 1,
                Name = "super admin",
                IsReadOnly= true,
                Guid = Guid.NewGuid().ToString(),
                IsDeleted = false
            };
            role.SetCreate();

            modelBuilder.Entity<UserRole>().HasData(role);

            //create admin user
            var salt = CryptoUtils.CreateRandomSalt();
            var userAccount = new UserAccount()
            {
                Id = 1,
                AccountType = UserAccountType.EXTERNAL,
                FirstName = "admin",
                Guid = Guid.NewGuid().ToString(),
                IsActive = true,
                IsSuperUser = true,
                LastName = "Shk Bilişim",
                UserName = "admin@shkbilisim.com",
                Salt = salt,
                Password = UserAccountOperations.GeneratePassword("1234", salt),
                Roles = "1",
                IsReadOnly=true
            };
            userAccount.SetCreate();

            modelBuilder.Entity<UserAccount>().HasData(userAccount);






        }
    }





}