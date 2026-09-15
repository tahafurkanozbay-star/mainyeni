using System;
using System.ComponentModel.DataAnnotations;
using Business._Base;
using Business.Core.Common;
using Business.Core.Model;
using Microsoft.EntityFrameworkCore;
using Business.Extensions.Gis.Model;
using Business.Extensions.FeedbackService.Model;

namespace Business.Core.Context
{
    public partial class BusinessContext : DbContext
    {
        public DbSet<Feedback> Feedbacks { get; set; }
    
    }      
}