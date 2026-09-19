import { WifiNoktalariQeryBusiness } from '../../../Business/WifiNoktalariQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Wi-Fi Noktaları',
  serviceKey: 'YeniWifiNoktalariQeryUrl',
  iconType: 'wifi erişim noktası',
  business: WifiNoktalariQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const WifiNoktalariQueryWindow = createManagedFastAccessQueryWindow(config);
