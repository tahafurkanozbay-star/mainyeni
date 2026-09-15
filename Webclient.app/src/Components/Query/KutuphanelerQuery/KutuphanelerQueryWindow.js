import { KutuphanelerQueryBusiness } from "../../../Business/KutuphanelerQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const KutuphanelerQueryWindow = createManagedFastAccessQueryWindow({
    title: "Kütüphaneler",
    serviceKey: "YeniKutuphanelerQueryUrl",
    iconType: "kütüphane",
    business: KutuphanelerQueryBusiness
});
