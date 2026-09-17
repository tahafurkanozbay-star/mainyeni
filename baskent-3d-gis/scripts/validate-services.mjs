import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve("public/services.json");
const data = JSON.parse(await readFile(file, "utf8"));
if (!Array.isArray(data.services)) throw new Error("services.json: 'services' bir dizi olmalı.");
const allowed = new Set(["WMS", "WFS", "MapServer", "FeatureServer", "SceneServer"]);
const errors = [];
for (const [index, service] of data.services.entries()) {
  for (const key of ["ustKurumAdi", "metaveriSahibiKurumAdi", "cografiVeriKatmanAdi", "servisTuruAdi", "tokenUrl"]) {
    if (typeof service[key] !== "string" || !service[key].trim()) errors.push(`#${index + 1}: ${key} eksik/geçersiz`);
  }
  if (!allowed.has(service.servisTuruAdi)) errors.push(`#${index + 1}: desteklenmeyen servis türü '${service.servisTuruAdi}'`);
  try { new URL(service.tokenUrl); } catch { errors.push(`#${index + 1}: tokenUrl geçerli URL değil`); }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`✓ ${data.services.length} servis doğrulandı.`);
