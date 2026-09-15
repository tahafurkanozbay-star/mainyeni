import axios from "axios";
import { AuthBusiness } from "./AuthBusiness";
import { LoggingBusiness } from "./LoggingBusiness";

jest.mock("axios", () => jest.fn());
jest.mock("./AuthBusiness", () => ({
    AuthBusiness: {
        GetRequestHeaders: jest.fn()
    }
}));

describe("LoggingBusiness", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AuthBusiness.GetRequestHeaders.mockResolvedValue({ Authorization: "Bearer test" });
    });

    test("posts log metadata to the same-origin client log endpoint", async () => {
        axios.mockResolvedValue({ status: 200 });

        await LoggingBusiness.CreateClientLog("qa", { message: "test" });

        expect(axios).toHaveBeenCalledTimes(1);
        const request = axios.mock.calls[0][0];
        expect(request.method).toBe("post");
        expect(request.url).toContain("/cl/c");
        expect(request.headers).toEqual({ Authorization: "Bearer test" });
        expect(request.data).toBeInstanceOf(FormData);
        expect(request.data.get("logType")).toBe("qa");
        expect(request.data.get("description")).toBe(JSON.stringify({ message: "test" }));
    });

    test("propagates transport failures to the caller", async () => {
        const error = new Error("log endpoint unavailable");
        axios.mockRejectedValue(error);

        await expect(LoggingBusiness.CreateClientLog("qa", {})).rejects.toBe(error);
    });
});
