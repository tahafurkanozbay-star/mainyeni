import { EgoMetroDuraklariQueryBusiness } from "../../../Business/EgoMetroDuraklariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoMetroDuraklariQueryWindow = createManagedFastAccessQueryWindow({
    title: "Metro Durakları",
    serviceKey: "YeniEgoMetroDuraklariQueryUrl",
    iconType: "metro hattı",
    business: EgoMetroDuraklariQueryBusiness
});
