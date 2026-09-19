import { SegmenSuFabrikalarıQeryBusiness } from '../../../Business/SegmenSuFabrikalarıQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Seğmen Su Fabrikaları',
  serviceKey: 'YeniSegmenSuFabrikalarıQeryUrl',
  iconType: 'segmen su',
  business: SegmenSuFabrikalarıQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const SegmenSuFabrikalarıQueryWindow = createManagedFastAccessQueryWindow(config);
