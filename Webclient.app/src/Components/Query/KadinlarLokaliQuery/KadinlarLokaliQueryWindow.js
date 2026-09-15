import { KadinLokaliQueryBusiness } from "../../../Business/KadinLokaliQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const KadinlarLokaliQueryWindow = createManagedFastAccessQueryWindow({
    title: "Kadınlar Lokali",
    serviceKey: "YeniKadinlarLokaliQeryUrl",
    iconType: "kadınlar lokali",
    business: KadinLokaliQueryBusiness
});
