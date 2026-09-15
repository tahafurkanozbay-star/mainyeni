import { IsNull } from "./ObjectHelper";
import { TextHelper } from "./TextHelper";

export const ArrayHelper = {
    Filter: (array, prop, value) => {
        const foundArray = [];
        if (array !== null && array !== undefined) {
            for (let i = 0, len = array.length; i < len; i++) {
                if (array[i] && array[i][prop] === value) {
                    array[i]._INDEX = i;
                    foundArray.push(array[i]);
                }
            }
        }
        return foundArray;
    },

    Find: (array, prop, value) => {
        const matches = ArrayHelper.Filter(array, prop, value);
        return matches.length > 0 ? matches[0] : null;
    },

    OrderByTurkish: (a, b, field) => {
        let targetField = field;
        if (IsNull(a[targetField])) targetField = TextHelper.TurkishToUpper(targetField);
        const aTitle = String(a[targetField] ?? "");
        const bTitle = String(b[targetField] ?? "");
        const alphabet = "0123456789AaBbCcÇçDdEeFfGgĞğHhIıİiJjKkLlMmNnOoÖöPpQqRrSsŞşTtUuÜüVvWwXxYyZz";
        if (aTitle.length === 0 || bTitle.length === 0) return aTitle.length - bTitle.length;
        for (let i = 0; i < aTitle.length && i < bTitle.length; i++) {
            const aIndex = alphabet.indexOf(aTitle[i].toUpperCase());
            const bIndex = alphabet.indexOf(bTitle[i].toUpperCase());
            if (aIndex !== bIndex) return aIndex - bIndex;
        }
        return aTitle.length - bTitle.length;
    },

    GroupBy: (array, key, hasAttr = false) => array.reduce((result, item) => {
        const groupKey = hasAttr ? item.attr[key] : item[key];
        (result[groupKey] = result[groupKey] || []).push(item);
        return result;
    }, {}),

    GroupByCount: (array, key) => {
        const counts = {};
        array.forEach(item => {
            const groupKey = item[key];
            counts[groupKey] = (counts[groupKey] || 0) + 1;
        });
        return Object.entries(counts).map(([groupKey, count]) => ({ key: groupKey, count }));
    },

    Distinct: array => array.filter((value, index) => {
        const serialized = JSON.stringify(value);
        return index === array.findIndex(item => JSON.stringify(item) === serialized);
    })
};
