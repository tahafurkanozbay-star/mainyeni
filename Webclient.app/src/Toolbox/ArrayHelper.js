import { IsNull } from "./ObjectHelper";
import { TextHelper } from "./TextHelper";

export const ArrayHelper = {

    Filter: (array, prop, value) => {

        let foundArray = [];
        if (array != null) {

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

        let arr=ArrayHelper.Filter(array, prop, value);
        if(arr.length>0){
            return arr[0];
        }
        else{
            return null;
        }
    },

    OrderByTurkish: (a, b, _field) => {

        if(IsNull(a[_field])){
            _field=TextHelper.TurkishToUpper(_field);
        }
        let atitle = a[_field];
        let btitle = b[_field];
        let alfabe = "0123456789AaBbCcÇçDdEeFfGgĞğHhIıİiJjKkLlMmNnOoÖöPpQqRrSsŞşTtUuÜüVvWwXxYyZz";
        if (atitle.length === 0 || btitle.length === 0) {
            return atitle.length - btitle.length;
        }
        for (let i = 0; i < atitle.length && i < btitle.length; i++) {
            let ai = alfabe.indexOf(atitle[i].toUpperCase());
            let bi = alfabe.indexOf(btitle[i].toUpperCase());
            if (ai !== bi) {
                return ai - bi;
            }
        }
    },

    GroupBy: (array, key, hasAttr = false) => {

        //usage GroupBy(['one', 'two', 'three'], 'length'));
        // => {3: ["one", "two"], 5: ["three"]}
        if (hasAttr) {
            return array.reduce(function (rv, x) {
                (rv[x.attr[key]] = rv[x.attr[key]] || []).push(x);
                return rv;
            }, {});
        }
        else {
            return array.reduce(function (rv, x) {
                (rv[x[key]] = rv[x[key]] || []).push(x);
                return rv;
            }, {});
        }

    },

    GroupByCount: (array, key) => {

        let counts = {};

        for (let i = 0; i < array.length; i++) {

            let keyx = array[i][key];

            if (counts[keyx]) {

                counts[keyx]++;
            } else {
                counts[keyx] = 1;
            }
        }

        let final = [];
        for (let keyxx in counts) {

            final.push({ key: keyxx, count: counts[keyxx] });
        }

        return final;
    },


    Distinct: (_array) => {

        const uniqueArray = _array.filter((value, index) => {

            const _value = JSON.stringify(value);

            return index === _array.findIndex(obj => {
                return JSON.stringify(obj) === _value;
            });

        });

        return uniqueArray;
    }


}

