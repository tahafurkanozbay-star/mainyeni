import { AppConfig } from '../Core/AppConfig';
import { AuthBusiness } from './AuthBusiness';
import { HttpBusiness } from './HttpBusiness';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export interface FeedbackType {
  readonly id: number;
  readonly name: string;
}

const FEEDBACK_TYPES: readonly FeedbackType[] = Object.freeze([
  Object.freeze({ id: 1, name: 'Uygulama hakkında görüş ve tavsiye' }),
  Object.freeze({ id: 2, name: 'Adres sorunu bildirme' }),
  Object.freeze({ id: 3, name: 'Veri sorunu bildirme' }),
]);

export const FeedbackBusiness = Object.freeze({
  SendFeedBack: async (formData: unknown, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<unknown | null> => {
    try {
      options.signal?.throwIfAborted();
      const headers = await AuthBusiness.GetRequestHeaders();
      options.signal?.throwIfAborted();
      return await HttpBusiness.Post(
        AppConfig.Api.BaseUrl + '/Feedback/Save',
        formData,
        { headers, ...(options.signal ? { signal: options.signal } : {}) },
      );
    } catch (error) {
      if (!options.signal?.aborted) {
        try { runtimeDiagnostics.captureError(error, { source: 'feedback-business.submit' }, 'warn'); }
        catch { console.warn('Feedback diagnostic reporting failed.'); }
      }
      return null;
    }
  },

  GetFeedbackTypes: (): readonly FeedbackType[] => FEEDBACK_TYPES,
});
