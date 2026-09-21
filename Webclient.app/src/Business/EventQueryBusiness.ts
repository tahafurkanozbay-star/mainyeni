import { createMapQueryBusiness } from './createMapQueryBusiness';

export const EventQueryBusiness = createMapQueryBusiness({
  serviceKey: 'EventQueryUrl',
  searchField: 'adi',
  orderByField: 'adi',
  includeDateRange: true,
});
