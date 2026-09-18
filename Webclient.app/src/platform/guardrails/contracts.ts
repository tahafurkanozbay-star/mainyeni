export type GuardrailDecision = 'allow' | 'deny' | 'normalize';
export interface GuardrailReason { readonly code: string; readonly message: string; }
