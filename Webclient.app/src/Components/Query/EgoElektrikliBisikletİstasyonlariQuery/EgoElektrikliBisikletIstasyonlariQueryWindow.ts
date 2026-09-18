import { EgoElektrikliBisikletİstasyonlariQueryBusiness } from '../../../Business/EgoElektrikliBisikletİstasyonlariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Elektrikli Bisiklet İstasyonları',
  serviceKey: 'YeniEgoElektrikliBisikletİstasyonlariQueryUrl',
  iconType: 'elektrikli bisiklet istasyonu',
  business: EgoElektrikliBisikletİstasyonlariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoElektrikliBisikletIstasyonlariQueryWindow = createManagedFastAccessQueryWindow(config);
