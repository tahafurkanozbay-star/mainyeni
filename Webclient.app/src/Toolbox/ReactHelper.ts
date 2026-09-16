import { useCallback, useState } from 'react';

export const useForceUpdate = (): (() => void) => {
  const [, setValue] = useState(0);
  return useCallback(() => setValue((value) => value + 1), []);
};
