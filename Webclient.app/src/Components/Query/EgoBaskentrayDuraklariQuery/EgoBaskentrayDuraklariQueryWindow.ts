import { EgoBaskentrayDuraklariQueryBusiness } from '../../../Business/EgoBaskentrayDuraklariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Başkentray Durakları',
  serviceKey: 'YeniEgoBaskentrayDuraklariQueryUrl',
  iconType: 'başkentray durağı',
  business: EgoBaskentrayDuraklariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoBaskentrayDuraklariQueryWindow = createManagedFastAccessQueryWindow(config);
