using Business._Base;

namespace Business.Core.ViewModel
{
    public class ClientLogSearchViewModel : _BaseViewModel
    {
        public string searchText { get; set; }
        public int pageNumber { get; set; }
        public int pageSize { get; set; }
        public string categories { get; set; } //kategoriler
        public string languages { get; set; } //diller
        public string pubtypes { get; set; } //yayın türleri
        public string countries { get; set; } //ülkeler

        public string order { get; set; } //Sıralama (A-Z,Z-A, yeniden eskiye, eskiden yeniye)
    }
}