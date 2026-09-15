import { BelkoMeyveSuyuSatisBufeleriQueryBusiness } from "../../../Business/BelkoMeyveSuyuSatisBufeleriQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const BelkoMeyveSuyuSatisBufeleriQueryWindow = createManagedFastAccessQueryWindow({
    title: "BELKO Meyve Suyu Satış Büfeleri",
    serviceKey: "YeniBelkoMeyveSuyuSatisBufeleriQueryUrl",
    iconType: "belko meyve suyu",
    business: BelkoMeyveSuyuSatisBufeleriQueryBusiness
});
