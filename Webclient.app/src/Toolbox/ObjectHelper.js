export function IsNull(obj) {
    return obj === null || obj === undefined || obj === "" || obj === "Null" || obj === "null";
}

export function HasNumeric(obj) {
    return /\d/.test(obj);
}

export function IsNumeric(obj) {
    return !Number.isNaN(Number.parseFloat(obj)) && Number.isFinite(Number(obj));
}

export function IsInt(n) {
    return Number(n) === n && n % 1 === 0;
}

export function IsFloat(n) {
    return Number(n) === n && n % 1 !== 0;
}

export function IsAlphabetic(obj) {
    return /^[a-zA-Z() ]+$/.test(obj);
}

export function clone(obj) {
    if (obj === null || obj === undefined || typeof obj !== "object") return obj;
    const copy = {};
    for (const attr in obj) copy[attr] = Object.assign({}, obj[attr]);
    return copy;
}
