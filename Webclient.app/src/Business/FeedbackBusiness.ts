import { AppConfig } from '../Core/AppConfig';
import { AuthBusiness } from './AuthBusiness';
import { HttpBusiness } from './HttpBusiness';

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
  SendFeedBack: async (formData: unknown): Promise<unknown | null> => {
    const headers = await AuthBusiness.GetRequestHeaders();

    try {
      return await HttpBusiness.Post(
        `${AppConfig.Api.BaseUrl}/Feedback/Save`,
        formData,
        { headers },
      );
    } catch {
      return null;
    }
  },

  GetFeedbackTypes: (): readonly FeedbackType[] => FEEDBACK_TYPES,
});
