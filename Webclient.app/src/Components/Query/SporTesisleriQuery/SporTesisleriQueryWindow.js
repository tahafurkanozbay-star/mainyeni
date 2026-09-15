import { SporTesisleriQeryBusiness } from "../../../Business/SporTesisleriQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const SporTesisleriQueryWindow = createManagedFastAccessQueryWindow({
    title: "Spor Tesisleri",
    serviceKey: "YeniSporTesisleriQeryUrl",
    iconType: "espor tesisi",
    business: SporTesisleriQeryBusiness
});
