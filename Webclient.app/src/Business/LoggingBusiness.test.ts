import { apiClient } from "../platform/http/httpClient";
import { LoggingBusiness } from "./LoggingBusiness";

vi.mock("../platform/http/httpClient", () => ({
    apiClient: {
        post: vi.fn()
    }
}));

describe("LoggingBusiness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test("posts log metadata to the same-origin client log endpoint", async () => {
        apiClient.post.mockResolvedValue({ status: 200 });

        await LoggingBusiness.CreateClientLog("qa", { message: "test" });

        expect(apiClient.post).toHaveBeenCalledTimes(1);
        const [url, data] = apiClient.post.mock.calls[0];
        expect(url).toBe("/cl/c");
        expect(data).toBeInstanceOf(FormData);
        expect(data.get("logType")).toBe("qa");
        expect(data.get("description")).toBe(JSON.stringify({ message: "test" }));
    });

    test("propagates transport failures to the caller", async () => {
        const error = new Error("log endpoint unavailable");
        apiClient.post.mockRejectedValue(error);

        await expect(LoggingBusiness.CreateClientLog("qa", {})).rejects.toBe(error);
    });
});
