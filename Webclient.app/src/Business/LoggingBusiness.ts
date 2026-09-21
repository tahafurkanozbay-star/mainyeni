import { apiClient } from '../platform/http/httpClient';

export const LoggingBusiness = Object.freeze({
  CreateClientLog: async (
    logType: unknown,
    description: unknown,
  ): Promise<unknown> => {
    const data = new FormData();
    data.append('logType', String(logType ?? ''));
    data.append('description', String(JSON.stringify(description)));
    return apiClient.post('/cl/c', data);
  },
});
