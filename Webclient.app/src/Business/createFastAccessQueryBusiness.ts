import type { QueryBusiness } from './contracts';
import { createFastAccessBusiness } from './fastAccessRuntime';

export const createFastAccessQueryBusiness = (serviceKey: string): QueryBusiness =>
  createFastAccessBusiness(serviceKey);
