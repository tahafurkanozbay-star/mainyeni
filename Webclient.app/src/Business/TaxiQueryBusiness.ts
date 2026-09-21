import { createMapQueryBusiness } from './createMapQueryBusiness';

export const TaxiQueryBusiness = createMapQueryBusiness({
  serviceKey: 'TaxiQueryUrl',
  searchField: 'adi',
  orderByField: 'adi',
});
