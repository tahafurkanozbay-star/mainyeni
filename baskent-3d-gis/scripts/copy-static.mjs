import { copyFile, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
await mkdir(new URL("assets/", dist), { recursive: true });
await Promise.all([
  copyFile(new URL("index.html", root), new URL("index.html", dist)),
  copyFile(new URL("src/style.css", root), new URL("assets/style.css", dist)),
  copyFile(new URL("public/services.json", root), new URL("services.json", dist)),
  copyFile(new URL("public/favicon.svg", root), new URL("favicon.svg", dist))
]);
console.log("✓ Statik dosyalar dist/ dizinine kopyalandı.");
