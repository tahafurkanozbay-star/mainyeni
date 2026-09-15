import { EgoBaskentrayDuraklariQueryBusiness } from "../../../Business/EgoBaskentrayDuraklariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoBaskentrayDuraklariQueryWindow = createManagedFastAccessQueryWindow({
    title: "Başkentray Durakları",
    serviceKey: "YeniEgoBaskentrayDuraklariQueryUrl",
    iconType: "başkentray durağı",
    business: EgoBaskentrayDuraklariQueryBusiness
});
