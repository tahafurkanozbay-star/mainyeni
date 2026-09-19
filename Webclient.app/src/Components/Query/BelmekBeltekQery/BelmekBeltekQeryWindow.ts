import { BelmekBeltekQeryBusiness } from '../../../Business/BelmekBeltekQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'BELMEK / BELTEK',
  serviceKey: 'YeniBelmekBeltekQeryUrl',
  iconType: 'belmek',
  business: BelmekBeltekQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const BelmekBeltekQeryWindow = createManagedFastAccessQueryWindow(config);
