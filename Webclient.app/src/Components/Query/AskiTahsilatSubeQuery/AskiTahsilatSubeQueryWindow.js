import { AskiTahsilatSubeQueryBusiness } from "../../../Business/AskiTahsilatSubeQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AskiTahsilatSubeQueryWindow = createManagedFastAccessQueryWindow({
    title: "ASKİ Tahsilat Şubeleri",
    serviceKey: "YeniAskiTahsilatSubeQueryUrl",
    iconType: "tahsilat şubesi",
    business: AskiTahsilatSubeQueryBusiness
});
