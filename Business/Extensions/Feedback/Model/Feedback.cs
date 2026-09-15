using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Business.Extensions.FeedbackService.Model
{
    public static class FeedbackTypes
    {
        public static List<FeedbackType> List = new List<FeedbackType>(){
            new FeedbackType { Name="Uygulama hakkında görüş ve tavsiye",Id=1},
            new FeedbackType { Name = "Adres sorunu bildirme", Id = 2 },
            new FeedbackType { Name = "Veri sorunu bildirme", Id = 3 }
        };
    }

    public class FeedbackType
    {
        public string Name { get; set; }
        public int Id { get; set; }

    }


    public static class FeedbackStatus
    {
        public static List<FeedbackState> List = new List<FeedbackState>(){
            new FeedbackState {Name="Beklemede",Id=1},
            new FeedbackState { Name = "Kapatıldı", Id = 2 },
            new FeedbackState { Name = "İptal Edildi", Id = 3 },

        };
    }

    public class FeedbackState
    {
        public string Name { get; set; }
        public int Id { get; set; }

    }



    public static class FeedbackActions
    {
        public static List<FeedbackActionTaken> List = new List<FeedbackActionTaken>(){
            new FeedbackActionTaken { Name="İşlem yapılmadı",Id=0},
            new FeedbackActionTaken { Name="Eposta ile cevap verildi",Id=1},
            new FeedbackActionTaken { Name = "Telefon ile cevap verildi", Id = 2 },
            new FeedbackActionTaken { Name = "Yüzyüze görüşüldü", Id = 3 },

        };
    }

    public class FeedbackActionTaken
    {
        public string Name { get; set; }
        public int Id { get; set; }

    }



    public class Feedback
    {
        public int Id { get; set; }
        public DateTime CreateDate { get; set; }
        public int FeedbackType { get; set; }
        public string Description { get; set; }
        public string FullName { get; set; }
        public string Country { get; set; }
        public string City { get; set; }
        public string Email { get; set; }
        public string Address { get; set; }
        public string Ip { get; set; }
        public string Browser { get; set; }
        public string Device { get; set; }
        public string Os { get; set; }
        public int Status { get; set; }
        public int ActionTaken { get; set; }
        public DateTime UpdateDate { get; set; }
        public int UpdatedBy { get; set; }
    }
}
