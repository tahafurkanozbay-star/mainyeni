import { apiClient } from "../platform/http/httpClient";
import { LoggingBusiness } from "./LoggingBusiness";

jest.mock("../platform/http/httpClient", () => ({
    apiClient: {
        post: jest.fn()
    }
}));

describe("LoggingBusiness", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("posts log metadata to the same-origin client log endpoint", async () => {
        apiClient.post.mockResolvedValue({ status: 200 });

        await LoggingBusiness.CreateClientLog("qa", { message: "test" });

        expect(apiClient.post).toHaveBeenCalledTimes(1);
        const [url, data, options] = apiClient.post.mock.calls[0];
        expect(url).toBe("/cl/c");
        expect(data).toBeInstanceOf(FormData);
        expect(data.get("logType")).toBe("qa");
        expect(data.get("description")).toBe(JSON.stringify({ message: "test" }));
        expect(options).toEqual({
            headers: { Accept: "application/json" },
            retryUnsafe: false
        });
    });

    test("propagates transport failures to the caller", async () => {
        const error = new Error("log endpoint unavailable");
        apiClient.post.mockRejectedValue(error);

        await expect(LoggingBusiness.CreateClientLog("qa", {})).rejects.toBe(error);
    });
});
