import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("GIS graphics helper TypeScript migration ratchet", () => {
  it("keeps the helper in the strict modern-GIS compiler boundary", () => {
    const toolboxRoot = resolve(process.cwd(), "src", "Toolbox");
    expect(existsSync(resolve(toolboxRoot, "GisGraphicsHelper.ts"))).toBe(true);
    expect(existsSync(resolve(toolboxRoot, "GisGraphicsHelper.js"))).toBe(false);

    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "tsconfig.gis-modern-core.json"), "utf8"),
    ) as { files?: string[] };
    expect(config.files).toContain("src/Toolbox/GisGraphicsHelper.ts");
  });
});
