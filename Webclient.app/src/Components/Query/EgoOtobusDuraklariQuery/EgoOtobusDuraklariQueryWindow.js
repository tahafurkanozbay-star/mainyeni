import { EgoOtobusDuraklariQueryBusiness } from "../../../Business/EgoOtobusDuraklariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoOtobusDuraklariQueryWindow = createManagedFastAccessQueryWindow({
    title: "Otobüs Durakları",
    serviceKey: "YeniEgoOtobusDuraklariQueryUrl",
    iconType: "otobüs durağı",
    business: EgoOtobusDuraklariQueryBusiness
});
