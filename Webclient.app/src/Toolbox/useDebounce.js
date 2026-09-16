import { useEffect, useState } from "react";

export const useDebounce = (value, delayMs) => {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => setDebouncedValue(value), delayMs);
        return () => window.clearTimeout(timeoutId);
    }, [delayMs, value]);

    return [debouncedValue];
};
