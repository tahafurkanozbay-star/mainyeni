import { SosyalHizmetlerQueryBusiness } from "../../../Business/SosyalHizmetlerQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const SosyalHizmetlerQueryWindow = createManagedFastAccessQueryWindow({
    title: "Sosyal Hizmetler",
    serviceKey: "YeniSosyalHizmetlerQueryUrl",
    iconType: "sosyal hizmetler",
    business: SosyalHizmetlerQueryBusiness
});
