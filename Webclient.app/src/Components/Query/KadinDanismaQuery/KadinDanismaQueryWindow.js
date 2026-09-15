import { KadinDanismaQueryBusiness } from "../../../Business/KadinDanismaQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const KadinDanismaQueryWindow = createManagedFastAccessQueryWindow({
    title: "Kadın Danışma Merkezi",
    serviceKey: "YeniKadinDanismaQueryUrl",
    iconType: "kadın danışma merkezi",
    business: KadinDanismaQueryBusiness
});
