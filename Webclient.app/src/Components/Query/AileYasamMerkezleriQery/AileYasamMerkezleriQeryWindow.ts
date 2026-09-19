import { AileYasamMerkezleriQeryBusiness } from '../../../Business/AileYasamMerkezleriQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Aile Yaşam Merkezleri',
  serviceKey: 'YeniAileYasamMerkezleriQeryUrl',
  iconType: 'aile yaşam merkezi',
  business: AileYasamMerkezleriQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AileYasamMerkezleriQeryWindow = createManagedFastAccessQueryWindow(config);
