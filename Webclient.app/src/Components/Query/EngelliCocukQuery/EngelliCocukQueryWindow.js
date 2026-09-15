import { EngelliCocukQueryBusiness } from "../../../Business/EngelliCocukQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EngelliCocukQueryWindow = createManagedFastAccessQueryWindow({
    title: "Engelli Çocuk Hizmetleri",
    serviceKey: "YeniEngelliCocukQueryUrl",
    iconType: "engelsiz kreş",
    business: EngelliCocukQueryBusiness
});
