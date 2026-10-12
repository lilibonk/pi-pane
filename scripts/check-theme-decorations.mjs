import { fileURLToPath } from "node:url";
import { validateDecorationResources } from "../src/extension/theme-decorations.ts";

validateDecorationResources(fileURLToPath(new URL("../", import.meta.url)));
console.log("Theme decoration manifest and SVG assets validated.");
