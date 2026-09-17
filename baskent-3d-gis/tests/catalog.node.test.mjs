import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/services/catalog.ts", import.meta.url), "utf8");
const services = JSON.parse(await readFile(new URL("../public/services.json", import.meta.url), "utf8"));

test("public servis kataloğu desteklenen servis türlerinden oluşur", () => {
  const supported = new Set(["WMS", "WFS", "MapServer", "FeatureServer", "SceneServer"]);
  assert.ok(services.services.length > 0);
  for (const service of services.services) assert.ok(supported.has(service.servisTuruAdi));
});

test("katman motoru WMS ve WFS desteğini korur", () => {
  assert.match(source, /\["WMS", "WFS", "MapServer", "FeatureServer", "SceneServer"\]/);
});

test("katalog normalizasyonunda Türkçe slug desteği bulunur", () => {
  assert.match(source, /normalize\("NFKD"\)/);
  assert.match(source, /replace\(\/ı\/g, "i"\)/);
});
