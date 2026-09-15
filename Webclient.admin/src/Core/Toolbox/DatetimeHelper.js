import { IsNull } from "./ObjectHelper";

export function ConvertFromEsriDate(esridate) {
    if (IsNull(esridate)) {
        return null;
    }
    else {
        return new Date(esridate).getDate() + "/"
            + (new Date(esridate).getMonth() + 1) + "/"
            + new Date(esridate).getFullYear()
    }
}


export function StringToDateTime(text, format) {
    var normalized = text.replace(/[^a-zA-Z0-9]/g, '-');
    var normalizedFormat = format.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
    var formatItems = normalizedFormat.split('-');
    var dateItems = normalized.split('-');

    var monthIndex = formatItems.indexOf("mm");
    var dayIndex = formatItems.indexOf("dd");
    var yearIndex = formatItems.indexOf("yyyy");
    var hourIndex = formatItems.indexOf("hh");
    var minutesIndex = formatItems.indexOf("ii");
    var secondsIndex = formatItems.indexOf("ss");

    var today = new Date();

    var year = yearIndex > -1 ? dateItems[yearIndex] : today.getFullYear();
    var month = monthIndex > -1 ? dateItems[monthIndex] - 1 : today.getMonth() - 1;
    var day = dayIndex > -1 ? dateItems[dayIndex] : today.getDate();

    var hour = hourIndex > -1 ? dateItems[hourIndex] : today.getHours();
    var minute = minutesIndex > -1 ? dateItems[minutesIndex] : today.getMinutes();
    var second = secondsIndex > -1 ? dateItems[secondsIndex] : today.getSeconds();

    return new Date(year, month, day, hour, minute, second);
};

export function diffMilliSeconds(end, begin) {

    var diffMs = (end - begin); // milliseconds
    return diffMs;
}

export function diffDays(end, begin) {

    var diffMs = (end - begin); // milliseconds
    var diffDays = Math.floor(diffMs / 86400000); // days
    return diffDays;
}


export function diffHrs(end, begin) {

    var diffMs = (end - begin); // milliseconds
    var diffHrs = Math.floor((diffMs % 86400000) / 3600000); // hours
    return diffHrs;
}

export function diffMins(end, begin) {

    var diffMs = (end - begin); // milliseconds
    var diffMins = Math.round(((diffMs % 86400000) % 3600000) / 60000); // minutes
    return diffMins;
}


export function GetFormatted() {

    let m = new Date();
    let dateString =
        ("0" + m.getDate()).slice(-2)
        + "/" +
        ("0" + (m.getMonth() + 1)).slice(-2)
        + "/"
        + m.getFullYear()
        + " - "
        + ("0" + m.getHours()).slice(-2)
        + ":"
        + ("0" + m.getMinutes()).slice(-2);
    return dateString;
}