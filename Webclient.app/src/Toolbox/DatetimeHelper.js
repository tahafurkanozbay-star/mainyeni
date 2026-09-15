import { IsNull } from "./ObjectHelper";


export const DatetimeHelper = {

    ConvertFromEsriDate: (esridate) => {
        if (IsNull(esridate)) {
            return null;
        }
        else {
            return new Date(esridate).getDate() + "/"
                + (new Date(esridate).getMonth() + 1) + "/"
                + new Date(esridate).getFullYear()
        }
    },

    StringToDateTime: (text, format) => {
        let normalized = text.replace(/[^a-zA-Z0-9]/g, '-');
        let normalizedFormat = format.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
        let formatItems = normalizedFormat.split('-');
        let dateItems = normalized.split('-');

        let monthIndex = formatItems.indexOf("mm");
        let dayIndex = formatItems.indexOf("dd");
        let yearIndex = formatItems.indexOf("yyyy");
        let hourIndex = formatItems.indexOf("hh");
        let minutesIndex = formatItems.indexOf("ii");
        let secondsIndex = formatItems.indexOf("ss");

        let today = new Date();

        let year = yearIndex > -1 ? dateItems[yearIndex] : today.getFullYear();
        let month = monthIndex > -1 ? dateItems[monthIndex] - 1 : today.getMonth() - 1;
        let day = dayIndex > -1 ? dateItems[dayIndex] : today.getDate();

        let hour = hourIndex > -1 ? dateItems[hourIndex] : today.getHours();
        let minute = minutesIndex > -1 ? dateItems[minutesIndex] : today.getMinutes();
        let second = secondsIndex > -1 ? dateItems[secondsIndex] : today.getSeconds();

        return new Date(year, month, day, hour, minute, second);
    },

    diffMilliSeconds: (end, begin) => {

        let diffMs = (end - begin); // milliseconds
        return diffMs;
    },
    diffDays: (end, begin) => {

        let diffMs = (end - begin); // milliseconds
        let diffDays = Math.floor(diffMs / 86400000); // days
        return diffDays;
    }
    ,
    diffHrs: (end, begin) => {

        let diffMs = (end - begin); // milliseconds
        let diffHrs = Math.floor((diffMs % 86400000) / 3600000); // hours
        return diffHrs;
    },
    diffMins: (end, begin) => {

        let diffMs = (end - begin); // milliseconds
        let diffMins = Math.round(((diffMs % 86400000) % 3600000) / 60000); // minutes
        return diffMins;
    },

    GetFormatted: (m, _showTime=true) => {

        let dateString =
            ("0" + m.getDate()).slice(-2)
            + "/" +
            ("0" + (m.getMonth() + 1)).slice(-2)
            + "/"
            + m.getFullYear();

            if(_showTime){
                dateString+= " - "
                + ("0" + m.getHours()).slice(-2)
                + ":"
                + ("0" + m.getMinutes()).slice(-2);
            }
            
        return dateString;
    }

}
