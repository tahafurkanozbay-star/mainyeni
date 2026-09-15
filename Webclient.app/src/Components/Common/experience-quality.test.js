import { normalizeCommandQuery } from "./experience-quality-utils";

describe("experience quality helpers", () => {
    test("normalizes Turkish search strings deterministically", () => {
        expect(normalizeCommandQuery("Katman Yönetimi")).toBe("katman yonetimi");
        expect(normalizeCommandQuery("  GENEL   ARAMA ")).toBe("genel arama");
    });
});
