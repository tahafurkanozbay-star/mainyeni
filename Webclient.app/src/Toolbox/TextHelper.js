export const TextHelper = {
    TurkishToUpper: (text) => text?.replace(/ğ/g, 'Ğ').replace(/ü/g, 'Ü').replace(/ş/g, 'Ş').replace(/ı/g, 'I').replace(/i/g, 'İ').replace(/ö/g, 'Ö').replace(/ç/g, 'Ç').toUpperCase(),

    TurkishToLower: (text) => text?.replace(/Ğ/g, 'ğ').replace(/Ü/g, 'ü').replace(/Ş/g, 'ş').replace(/I/g, 'i').replace(/İ/g, 'i').replace(/Ö/g, 'ö').replace(/Ç/g, 'ç').toLowerCase(),

    UnicodeToUtf8: (text) => text
        .replace(/Ãœ/g, 'Ü').replace(/Ä°/g, 'İ').replace(/Ã‡/g, 'Ç').replace(/Ã–/g, 'Ö')
        .replace(/Ã¼/g, 'ü').replace(/ÅŸ/g, 'ş').replace(/ÄŸ/g, 'ğ').replace(/Ã§/g, 'ç')
        .replace(/Ä±/g, 'ı').replace(/Ã¶/g, 'ö').replace(/Å/g, 'Ş').replace(/Ä/g, 'Ğ'),

    convertToASCII: (text) => text
        .replace(/\u00c2/g, 'A')
        .replace(/\u00e2/g, 'a')
        .replace(/\u00fb/g, 'u')
        .replace(/\u0130/g, 'I')
        .replace(/\u0131/g, 'i')
        .replace(/\u015e/g, 'S')
        .replace(/\u015f/g, 's')
        .replace(/\u00dc/g, 'U')
        .replace(/\u00fc/g, 'u'),

    ToTurkish: (text) => {
        const result = [];
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            const character = text.charAt(i);
            if (code === 105) result.push('İ');
            else if (code === 305) result.push('I');
            else if (code === 287) result.push('Ğ');
            else if (code === 252) result.push('Ü');
            else if (code === 351) result.push('Ş');
            else if (code === 246) result.push('Ö');
            else if (code === 231) result.push('Ç');
            else if (code >= 97 && code <= 122) result.push(character.toUpperCase());
            else result.push(character);
        }
        return result.join('');
    },

    RemoveTurkishChars: (text) => {
        const charMap = { Ç: 'C', Ö: 'O', Ş: 'S', İ: 'I', Ü: 'U', Ğ: 'G', ç: 'c', ö: 'o', ş: 's', ı: 'i', ü: 'u', ğ: 'g' };
        return String(text ?? '')
            .split('')
            .map(character => charMap[character] || character)
            .join('')
            .replace(/[^a-z0-9-.çöşüğı\s+]/gi, "");
    },

    CreateRandomColor: () => "#" + Math.floor(Math.random() * 16777215).toString(16),

    CreateRandomDarkColor: () => {
        let color = '#';
        for (let i = 0; i < 6; i++) color += Math.floor(Math.random() * 10);
        return color;
    },

    CreateRandomNumber: () => {
        const cryptoApi = window.crypto || window.msCrypto;
        const array = new Uint32Array(1);
        return cryptoApi.getRandomValues(array)[0] / 1000;
    },

    CreateGuid: () => {
        const s4 = () => Math.floor((1 + TextHelper.CreateRandomNumber()) * 0x10000).toString(16).substring(1);
        return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
    },

    ToLowerCase: (obj) => obj.toLowerCase().replace("İ", "i"),

    ShortenText: (text, maxlength) => text ? ((text.length >= maxlength) ? text.substr(0, maxlength - 1) + '&hellip;' : text) : text,

    SanitizeString: (str) => str.replace(/[^a-zA-Z0-9áéíóúñüİıÖöÜüÇçŞşĞğ\s.,_-]/gim, "")
};
