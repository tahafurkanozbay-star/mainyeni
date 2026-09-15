using System;
using System.ComponentModel.DataAnnotations;
using Business._Base;
using Business.Core.Common;
using Business.Core.Model;
using Microsoft.EntityFrameworkCore;
using Business.Extensions.Gis.Model;

namespace Business.Core.Context
{
    public partial class BusinessContext : DbContext
    {
        public DbSet<GisBookmark> GisBookmarks { get; set; }
        public DbSet<GisLayer> GisLayers { get; set; }
        public DbSet<GisLayerGroup> GisLayerGroups { get; set; }
        public DbSet<GisBasemapLayer> GisBasemapLayers { get; set; }
        public DbSet<GisConfigService> GisConfigServices { get; set; }

    }      
}