import { TeknolojiMerkezleriQueryBusiness } from '../../../Business/TeknolojiMerkezleriQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Teknoloji Merkezleri',
  serviceKey: 'YeniTeknolojiMerkezleriQueryUrl',
  iconType: 'teknoloji merkezi',
  business: TeknolojiMerkezleriQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const TeknolojiMerkezleriQueryWindow = createManagedFastAccessQueryWindow(config);
