import { AskiKartDolumOdemeQueryBusiness } from "../../../Business/AskiKartDolumOdemeQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AskiKartDolumOdemeQueryWindow = createManagedFastAccessQueryWindow({
    title: "ASKİ Kart Dolum ve Ödeme",
    serviceKey: "YeniAskiKartDolumOdemeQueryUrl",
    iconType: "kart dolum",
    business: AskiKartDolumOdemeQueryBusiness
});
