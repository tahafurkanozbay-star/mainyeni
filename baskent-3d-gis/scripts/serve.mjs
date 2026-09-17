import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT ?? 4173);
const root = new URL("../dist/", import.meta.url).pathname;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8" };

createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const safe = normalize(raw).replace(/^([.][.][/\\])+/, "");
    let file = join(root, safe === "/" ? "index.html" : safe);
    try { if ((await stat(file)).isDirectory()) file = join(file, "index.html"); } catch { /* handled below */ }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}).listen(port, "0.0.0.0", () => console.log(`3B CBS Başkent: http://localhost:${port}`));
