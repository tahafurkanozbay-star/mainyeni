import { HalkEkmekQueryBusiness } from '../../../Business/HalkEkmekQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Halk Ekmek Satış Noktaları',
  serviceKey: 'YeniHalkEkmekSatisNoktalariQeryUrl',
  iconType: 'halk ekmek',
  business: HalkEkmekQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const HalkEkmekQueryWindow = createManagedFastAccessQueryWindow(config);
