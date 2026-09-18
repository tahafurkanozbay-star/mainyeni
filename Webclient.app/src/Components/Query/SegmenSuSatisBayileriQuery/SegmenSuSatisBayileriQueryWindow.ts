import { SegmenSuSatisBayileriQeryBusiness } from '../../../Business/SegmenSuSatisBayileriQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Seğmen Su Satış Bayileri',
  serviceKey: 'YeniSegmenSuSatisBayileriQeryUrl',
  iconType: 'segmen su',
  business: SegmenSuSatisBayileriQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const SegmenSuSatisBayileriQueryWindow = createManagedFastAccessQueryWindow(config);
