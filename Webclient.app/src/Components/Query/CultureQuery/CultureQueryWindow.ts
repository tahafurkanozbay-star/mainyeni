import { CultureQueryBusiness } from '../../../Business/CultureQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Kültür ve Sanat',
  serviceKey: 'YeniKültürSanatQueryUrl',
  iconType: 'kültür sanat',
  business: CultureQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const CultureQueryWindow = createManagedFastAccessQueryWindow(config);
