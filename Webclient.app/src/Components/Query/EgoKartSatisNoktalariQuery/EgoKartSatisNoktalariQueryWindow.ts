import { EgoKartSatisNoktalariQueryBusiness } from '../../../Business/EgoKartSatisNoktalariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'EGO Kart Satış Noktaları',
  serviceKey: 'YeniEgoKartSatisNoktalariQueryUrl',
  iconType: 'kart satış noktası',
  business: EgoKartSatisNoktalariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoKartSatisNoktalariQueryWindow = createManagedFastAccessQueryWindow(config);
