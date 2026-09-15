import { EgoTeleferikDuraklariQueryBusiness } from "../../../Business/EgoTeleferikDuraklariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoTeleferikDuraklariQueryWindow = createManagedFastAccessQueryWindow({
    title: "Teleferik Durakları",
    serviceKey: "YeniEgoTeleferikDuraklariQueryUrl",
    iconType: "teleferik durağı",
    business: EgoTeleferikDuraklariQueryBusiness
});
