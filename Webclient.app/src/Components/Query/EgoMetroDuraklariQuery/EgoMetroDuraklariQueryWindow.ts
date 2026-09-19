import { EgoMetroDuraklariQueryBusiness } from '../../../Business/EgoMetroDuraklariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Metro Durakları',
  serviceKey: 'YeniEgoMetroDuraklariQueryUrl',
  iconType: 'metro hattı',
  business: EgoMetroDuraklariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoMetroDuraklariQueryWindow = createManagedFastAccessQueryWindow(config);
