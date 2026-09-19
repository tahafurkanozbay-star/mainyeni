import { EgoKartDolumNoktalariQeryBusiness } from '../../../Business/EgoKartDolumNoktalariQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'EGO Kart Dolum Noktaları',
  serviceKey: 'YeniEgoKartDolumNoktalariQeryUrl',
  iconType: 'kart dolum noktası',
  business: EgoKartDolumNoktalariQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoKartDolumNoktalariQeryWindow = createManagedFastAccessQueryWindow(config);
