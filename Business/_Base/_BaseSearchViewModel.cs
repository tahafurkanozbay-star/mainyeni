namespace Business._Base
{
    public class _BaseSearchViewModel
    {
        public string searchText { get; set; }
        public int PageNumber { get; set; }
        public int PageSize { get; set; }

        public string order { get; set; } //Sıralama (A-Z,Z-A, yeniden eskiye, eskiden yeniye)
        public int TotalRowCount { get; internal set; }
    }
}
