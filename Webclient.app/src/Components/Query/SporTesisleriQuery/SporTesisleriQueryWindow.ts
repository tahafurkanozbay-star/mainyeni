import { SporTesisleriQeryBusiness } from '../../../Business/SporTesisleriQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Spor Tesisleri',
  serviceKey: 'YeniSporTesisleriQeryUrl',
  iconType: 'espor tesisi',
  business: SporTesisleriQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const SporTesisleriQueryWindow = createManagedFastAccessQueryWindow(config);
