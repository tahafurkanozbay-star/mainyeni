import { EgoTeleferikDuraklariQueryBusiness } from '../../../Business/EgoTeleferikDuraklariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Teleferik Durakları',
  serviceKey: 'YeniEgoTeleferikDuraklariQueryUrl',
  iconType: 'teleferik durağı',
  business: EgoTeleferikDuraklariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoTeleferikDuraklariQueryWindow = createManagedFastAccessQueryWindow(config);
