import { AskiBolgeMudurlukleriQeryBusiness } from "../../../Business/AskiBolgeMudurlukleriQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AskiBolgeMudurlukleriQeryWindow = createManagedFastAccessQueryWindow({
    title: "ASKİ Bölge Müdürlükleri",
    serviceKey: "YeniAskiBolgeMudurlukleriQeryUrl",
    iconType: "bölge müdürlüğü",
    business: AskiBolgeMudurlukleriQeryBusiness
});
