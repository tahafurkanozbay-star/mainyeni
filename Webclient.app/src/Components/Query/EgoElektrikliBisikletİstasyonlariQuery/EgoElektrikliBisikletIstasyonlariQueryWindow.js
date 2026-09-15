import { EgoElektrikliBisikletİstasyonlariQueryBusiness } from "../../../Business/EgoElektrikliBisikletİstasyonlariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoElektrikliBisikletIstasyonlariQueryWindow = createManagedFastAccessQueryWindow({
    title: "Elektrikli Bisiklet İstasyonları",
    serviceKey: "YeniEgoElektrikliBisikletİstasyonlariQueryUrl",
    iconType: "elektrikli bisiklet istasyonu",
    business: EgoElektrikliBisikletİstasyonlariQueryBusiness
});
