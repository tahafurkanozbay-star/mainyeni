import { PortasAsfaltUretimQeryBusiness } from '../../../Business/PortasAsfaltUretimQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'PORTAŞ Asfalt Üretim',
  serviceKey: 'YeniPortasAsfaltUretimQeryUrl',
  iconType: 'portas asfalt',
  business: PortasAsfaltUretimQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const PortasAsfaltUretimQueryWindow = createManagedFastAccessQueryWindow(config);
