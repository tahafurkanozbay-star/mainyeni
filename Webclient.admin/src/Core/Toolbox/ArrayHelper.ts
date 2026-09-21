export function FindInArray(array, prop, value) {

    var foundArray=[];
    if (array != null) {
        for (var i = 0, len = array.length; i < len; i++)
        {
            if (array[i] && array[i][prop] === value) {
                array[i]._INDEX=i;    
                foundArray.push(array[i]);
            }
        }
    }
    return foundArray;
}

export function GroupBy(array, key) {
    //usage GroupBy(['one', 'two', 'three'], 'length'));
    // => {3: ["one", "two"], 5: ["three"]}
    return array.reduce(function (rv, x) {
        (rv[x[key]] = rv[x[key]] || []).push(x);
        return rv;
    }, {});
}



export function GroupByCount(array, key) {

    var counts = {};
    for (var i = 0; i < array.length; i++) {

        var keyx = array[i][key];
        if (counts[keyx]) {

            counts[keyx]++;
        } else {
            counts[keyx] = 1;
        }
    }

    var final = [];
    for (var keyx in counts) {

        final.push({ key: keyx, count: counts[keyx] });
    }
    return final;
}
