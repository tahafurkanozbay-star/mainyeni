export const TextHelper = {

    TurkishToUpper: (text) => {
        return text?.replace(/ğ/g, 'Ğ')
            .replace(/ü/g, 'Ü')
            .replace(/ş/g, 'Ş')
            .replace(/ı/g, 'I')
            .replace(/i/g, 'İ')
            .replace(/ö/g, 'Ö')
            .replace(/ç/g, 'Ç')
            .toUpperCase();
    }

    , TurkishToLower: (text) => {
        return text?.replace(/Ğ/g, 'ğ')
            .replace(/Ü/g, 'ü')
            .replace(/Ş/g, 'ş')
            .replace(/I/g, 'i')
            .replace(/İ/g, 'i')
            .replace(/Ö/g, 'ö')
            .replace(/Ç/g, 'ç')
            .toLowerCase();
    }


    , UnicodeToUtf8: (text) => {

        text = text.replace(/Ãœ/g, 'Ü');
        text = text.replace(/Ä°/g, 'İ');
        text = text.replace(/Ã‡/g, 'Ç');
        text = text.replace(/Ã–/g, 'Ö');

        text = text.replace(/Ã¼/g, 'ü');
        text = text.replace(/ÅŸ/g, 'ş');
        text = text.replace(/ÄŸ/g, 'ğ');
        text = text.replace(/Ã§/g, 'ç');
        text = text.replace(/Ä±/g, 'ı');
        text = text.replace(/Ã¶/g, 'ö');
        text = text.replace(/Å/g, 'Ş');
        text = text.replace(/Ä/g, 'Ğ');

        return text;
    }


    , convertToASCII: (text) => {

        text = text.replace(/\u00c2/g, 'A'); // Â
        text = text.replace(/\u00e2/g, 'a'); // â
        text = text.replace(/\u00fb/g, 'u'); // û
        //text = text.replace(/\u00c7/g, 'C'); // Ç
        //text = text.replace(/\u00e7/g, 'c'); // ç
        //text = text.replace(/\u011e/g, 'G'); // Ğ
        //text = text.replace(/\u011f/g, 'g'); // ğ
        text = text.replace(/\u0130/g, 'I'); // İ
        text = text.replace(/\u0131/g, 'i'); // ı
        text = text.replace(/\u015e/g, 'S'); // Ş
        text = text.replace(/\u015f/g, 's'); // ş
        //text = text.replace(/\u00d6/g, 'O'); // Ö
        //text = text.replace(/\u00f6/g, 'o'); // ö
        text = text.replace(/\u00dc/g, 'U'); // Ü
        text = text.replace(/\u00fc/g, 'u'); // ü

        return text;
    }


    , ToTurkish: (text) => {
        let str = [];

        for (let i = 0; i < text.length; i++) {
            let ch = text.charCodeAt(i);
            let c = text.charAt(i);
            if (ch == 105) str.push('İ');
            else if (ch == 305) str.push('I');
            else if (ch == 287) str.push('Ğ');
            else if (ch == 252) str.push('Ü');
            else if (ch == 351) str.push('Ş');
            else if (ch == 246) str.push('Ö');
            else if (ch == 231) str.push('Ç');
            else if (ch >= 97 && ch <= 122) str.push(c.toUpperCase());
            else str.push(c);
        }
        return str.join('');
    }


    , RemoveTurkishChars: (text) => {


        let charMap = {
            Ç: 'C',
            Ö: 'O',
            Ş: 'S',
            İ: 'I',
            Ü: 'U',
            Ğ: 'G',
            ç: 'c',
            ö: 'o',
            ş: 's',
            ı: 'i',
            ü: 'u',
            ğ: 'g'
        };

        let str = text;
        let str_array = str.split('');


        for (let i = 0, len = str_array.length; i < len; i++) {
            str_array[i] = charMap[str_array[i]] || str_array[i];
        }

        str = str_array.join('');

        let clearStr = str.replace(/[^a-z0-9-.çöşüğı\s+]/gi, "");

        let print = clearStr;

        return print;


    }

    , CreateRandomColor: () => {

        var randomColor = Math.floor(Math.random() * 16777215).toString(16);
        return "#" + randomColor.toString();

    }

    , CreateRandomDarkColor: () => {
        var color = '#';
        for (var i = 0; i < 6; i++) {
            color += Math.floor(Math.random() * 10);
        }
        return color;
    }

    , CreateRandomNumber: () => {
        const crypto = window.crypto || window.msCrypto;
        const array = new Uint32Array(1);
        return crypto.getRandomValues(array)[0] / 1000;
    }

    , CreateGuid: () => {
        function s4() {
            return Math.floor((1 + TextHelper.CreateRandomNumber()) * 0x10000)
                .toString(16)
                .substring(1);
        }
        return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
    }


    , ToLowerCase: (obj) => {
        return obj.toLowerCase().replace("İ", "i");
    }

    , ShortenText: (text, maxlength) => {
        if (text) {
            return (text.length >= maxlength) ? text.substr(0, maxlength - 1) + '&hellip;' : text;
        }
        else {
            return text;
        }
    },


    SanitizeString:(str)=>{
        str = str.replace(/[^a-zA-Z0-9áéíóúñüİıÖöÜüÇçŞşĞğ\s\.,_-]/gim,"");
        return str;
    }

}
