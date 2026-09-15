using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Toolbox.Generic
{
    public class PdfUtility
    {

        public string GetContent(string filePath)
        {
            var sb = new StringBuilder();   
            using (var stream = File.OpenRead(filePath))
            {
                using (UglyToad.PdfPig.PdfDocument document = UglyToad.PdfPig.PdfDocument.Open(stream))
                {
                    foreach (var page in document.GetPages())
                    {
                        sb.Append(string.Join(" ", page.GetWords()));
                    }

                }

            }
            return sb.ToString();
           
        }

    }
}
