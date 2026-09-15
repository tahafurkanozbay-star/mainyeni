using Business.Core.Common;
using Business.Core.Model;
using Microsoft.EntityFrameworkCore;

namespace Business.Core.Context
{
    public partial class BusinessContext : DbContext
    {
        public DbSet<AppConfig> AppConfigs { get; set; }
        public DbSet<BusinessException> BusinessExceptions { get; set; }
        public DbSet<ClientLog> ClientLogs { get; set; }
        public DbSet<UserAccount> UserAccounts { get; set; }
        public DbSet<UserRole> UserRoles { get; set; }
        public DbSet<UserRoleRegistration> UserRoleRegistrations { get; set; }

        public BusinessContext(DbContextOptions<BusinessContext> options)
            : base(options)
        {
        }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.HasDefaultSchema(Configuration.SCHEMA_NAME);

            // Security-sensitive identities are intentionally not seeded from source code.
            // Bootstrap administrators must be provisioned through a deployment/runbook process
            // that receives credentials from the environment/secret store and requires rotation.
            // This also keeps the EF model deterministic (no Guid.NewGuid/DateTime seed values).
            base.OnModelCreating(modelBuilder);
        }
    }
}
