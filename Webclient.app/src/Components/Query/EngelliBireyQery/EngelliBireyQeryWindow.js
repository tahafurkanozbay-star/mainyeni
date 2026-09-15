import { EngelliBireyQeryBusiness } from "../../../Business/EngelliBireyQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EngelliBireyQeryWindow = createManagedFastAccessQueryWindow({
    title: "Engelli Birey Hizmetleri",
    serviceKey: "YeniEngelliBireyQeryUrl",
    iconType: "engelsiz yaşam",
    business: EngelliBireyQeryBusiness
});
