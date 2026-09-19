export interface CommonBusinessServiceDescriptor {
  readonly eg?: unknown;
  readonly Eg?: unknown;
  readonly url?: unknown;
  readonly Url?: unknown;
  readonly [key: string]: unknown;
}

export interface CommonBusinessContract {
  readonly GenerateUrl: (service: CommonBusinessServiceDescriptor) => unknown;
  readonly AddProxyRule: (url: string, source?: string) => Promise<unknown> | unknown;
}

export declare const CommonBusiness: CommonBusinessContract;
