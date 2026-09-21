export function IsNull(obj){
    if (obj == null || obj == "" || obj == "Null" || obj == "null" || obj == undefined) {

        return true;
    }
    else {

        return false;
    }
};

export function HasNumeric(obj) {

    return /\d/.test(obj);
};

export function IsNumeric(obj) {
    return !isNaN(parseFloat(obj)) && isFinite(obj);
};

export function IsInt(n) {
    return Number(n) === n && n % 1 === 0;
};

export function IsFloat(n) {
    return Number(n) === n && n % 1 !== 0;
};

export function IsAlphabetic(obj) {
    return /^[a-zA-Z() ]+$/.test(obj);
};

export function clone(obj) {
    if (null == obj || "object" != typeof obj) return obj;
    var copy = obj.constructor();
    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) copy[attr] = obj[attr];
    }
    return copy;
}

