import { useEffect, useState } from 'react';

export const useDebounce = (value, delayMs = 0) => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const delay = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : 0;
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return [debounced];
};
