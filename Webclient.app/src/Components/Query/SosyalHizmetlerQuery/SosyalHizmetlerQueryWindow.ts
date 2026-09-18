import { SosyalHizmetlerQueryBusiness } from '../../../Business/SosyalHizmetlerQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Sosyal Hizmetler',
  serviceKey: 'YeniSosyalHizmetlerQueryUrl',
  iconType: 'sosyal hizmetler',
  business: SosyalHizmetlerQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const SosyalHizmetlerQueryWindow = createManagedFastAccessQueryWindow(config);
