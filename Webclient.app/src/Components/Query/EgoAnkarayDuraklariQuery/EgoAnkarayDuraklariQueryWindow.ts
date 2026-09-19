import { EgoAnkarayDuraklariQueryBusiness } from '../../../Business/EgoAnkarayDuraklariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ANKARAY Durakları',
  serviceKey: 'YeniEgoAnkarayDuraklariQueryUrl',
  iconType: 'ankaray durağı',
  business: EgoAnkarayDuraklariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoAnkarayDuraklariQueryWindow = createManagedFastAccessQueryWindow(config);
