import { EgoAnkarayDuraklariQueryBusiness } from "../../../Business/EgoAnkarayDuraklariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoAnkarayDuraklariQueryWindow = createManagedFastAccessQueryWindow({
    title: "ANKARAY Durakları",
    serviceKey: "YeniEgoAnkarayDuraklariQueryUrl",
    iconType: "ankaray durağı",
    business: EgoAnkarayDuraklariQueryBusiness
});
