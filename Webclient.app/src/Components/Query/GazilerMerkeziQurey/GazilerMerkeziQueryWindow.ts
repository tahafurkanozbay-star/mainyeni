import { GazilerMerkeziQeyBusiness } from '../../../Business/GazilerMerkeziQeyBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Gaziler Merkezi',
  serviceKey: 'YeniGazilerMerkeziQeyUrl',
  iconType: 'gazi merkezi',
  business: GazilerMerkeziQeyBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const GazilerMerkeziQueryWindow = createManagedFastAccessQueryWindow(config);
