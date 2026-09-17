const DEFAULT_TIMEOUT_MS = 15000;

const appendQuery = (url, params) => {
    if (!params) return url;

    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) searchParams.set(key, String(value));
    });

    const query = searchParams.toString();
    if (!query) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
};

const readResponseData = async response => {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

export const requestData = async (url, options = {}) => {
    const {
        method = "GET",
        headers,
        body,
        params,
        signal,
        timeoutMs = DEFAULT_TIMEOUT_MS
    } = options;

    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener?.("abort", abortFromParent, { once: true });

    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(appendQuery(url, params), {
            method,
            headers,
            body,
            signal: controller.signal
        });
        const data = await readResponseData(response);

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.data = data;
            throw error;
        }

        return data;
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("İstek zaman aşımına uğradı.");
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
        signal?.removeEventListener?.("abort", abortFromParent);
    }
};

export const HttpBusiness = {
    Get: (url, options = {}) => requestData(url, { ...options, method: "GET" }),
    Post: (url, data, options = {}) => requestData(url, {
        ...options,
        method: "POST",
        body: options.body ?? JSON.stringify(data)
    })
};
