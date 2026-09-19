import {
  buildGoogleRouteUrl,
  filterFastAccessRecords,
  getFastAccessRecordKey,
  normalizeFastAccessRecord
} from "./ManagedFastAccessQueryWindow";

describe("ManagedFastAccessQueryWindow helpers", () => {
  test("normalizes heterogeneous fast-access attributes", () => {
    expect(normalizeFastAccessRecord({
      attr: { OBJECTID: 42, ADI: "Ankara Parkı", ADRES: "Çankaya", TELEFON: "0312 000 00 00" }
    })).toMatchObject({
      objectId: 42,
      title: "Ankara Parkı",
      address: "Çankaya",
      phone: "0312 000 00 00"
    });
  });

  test("normalizes alternative English attribute names", () => {
    expect(normalizeFastAccessRecord({
      attributes: { id: "abc", name: "Service", address: "Center", phone: "+90 312" }
    })).toMatchObject({
      objectId: "abc",
      title: "Service",
      address: "Center",
      phone: "+90 312"
    });
  });

  test("normalizes Turkish dotted and dotless key variants", () => {
    expect(normalizeFastAccessRecord({
      attr: { FID: 9, İSİM: "Kütüphane", AÇIK_ADRES: "Kızılay" }
    })).toMatchObject({
      objectId: 9,
      title: "Kütüphane",
      address: "Kızılay"
    });
  });

  test("falls back without exposing undefined labels", () => {
    expect(normalizeFastAccessRecord({ attr: {} }, 2)).toMatchObject({
      title: "Kayıt 3",
      address: "Adres bilgisi bulunmuyor",
      phone: ""
    });
  });

  test("preserves the raw feature for detail fallbacks", () => {
    const feature = { attr: { ADI: "Park" }, geometry: { x: 32.8, y: 39.9 } };
    expect(normalizeFastAccessRecord(feature).raw).toBe(feature);
  });

  test("filters Turkish text diacritic-insensitively", () => {
    const records = [
      { title: "Kütüphane", address: "Çankaya", phone: "" },
      { title: "Park", address: "Keçiören", phone: "" }
    ];
    expect(filterFastAccessRecords(records, "kutuphane")).toHaveLength(1);
    expect(filterFastAccessRecords(records, "kecioren")).toHaveLength(1);
  });

  test("filters by phone and address as well as title", () => {
    const records = [
      { title: "Merkez", address: "Ulus", phone: "0312 111 22 33" },
      { title: "Şube", address: "Bahçelievler", phone: "0312 999 88 77" }
    ];
    expect(filterFastAccessRecords(records, "111 22")).toEqual([records[0]]);
    expect(filterFastAccessRecords(records, "bahcelievler")).toEqual([records[1]]);
  });

  test("returns the original record list for an empty filter", () => {
    const records = [{ title: "A" }, { title: "B" }];
    expect(filterFastAccessRecords(records, "")).toBe(records);
    expect(filterFastAccessRecords(records, "   ")).toBe(records);
  });

  test("creates a route only for finite coordinates", () => {
    expect(buildGoogleRouteUrl({ latitude: 39.92, longitude: 32.85 })).toContain("39.92%2C32.85");
    expect(buildGoogleRouteUrl({})).toBeNull();
  });

  test("creates a route for x/y point geometry", () => {
    expect(buildGoogleRouteUrl({ x: 32.85, y: 39.92 })).toContain("39.92%2C32.85");
  });

  test("creates a route for non-point geometry using extent center", () => {
    expect(buildGoogleRouteUrl({
      extent: { center: { x: 32.7, y: 39.8 } }
    })).toContain("39.8%2C32.7");
  });

  describe("stable record keys", () => {
    test("prefers object id", () => {
      expect(getFastAccessRecordKey({ objectId: 42, title: "A", address: "B" }, 0)).toBe("42");
    });

    test("uses global id when object id is unavailable", () => {
      expect(getFastAccessRecordKey({
        objectId: null,
        title: "A",
        address: "B",
        raw: { attr: { GLOBALID: "global-123" } }
      }, 3)).toBe("global-123");
    });

    test("builds deterministic fallback keys from copy", () => {
      const record = { objectId: null, title: "Ankara Kütüphanesi", address: "Çankaya", raw: { attr: {} } };
      expect(getFastAccessRecordKey(record, 5)).toBe("ankara kutuphanesi-cankaya-5");
      expect(getFastAccessRecordKey(record, 5)).toBe(getFastAccessRecordKey(record, 5));
    });

    test("different fallback indexes avoid collisions for duplicate copy", () => {
      const record = { objectId: null, title: "Aynı", address: "Adres", raw: { attr: {} } };
      expect(getFastAccessRecordKey(record, 0)).not.toBe(getFastAccessRecordKey(record, 1));
    });
  });
});
