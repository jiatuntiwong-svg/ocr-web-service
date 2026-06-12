// POC 2 — try pure-JS extraction of .doc text via office-text-extractor.
// Run: node scripts/poc-doc-extraction/run-poc-lib.mjs

import { getTextExtractor } from "office-text-extractor";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = [
    join(__dirname, "..", "poc-excel-extraction", "samples", "BKKA20721000.doc"),
    join(__dirname, "..", "poc-excel-extraction", "samples", "BKKFY3315800.doc"),
];

const extractor = getTextExtractor();

for (const filePath of SAMPLES) {
    const name = basename(filePath);
    console.log("\n" + "═".repeat(80));
    console.log(`FILE: ${name}`);
    console.log("═".repeat(80));

    try {
        const start = Date.now();
        const text = await extractor.extractText({ input: filePath, type: "file" });
        const ms = Date.now() - start;
        console.log(`✓ Extracted ${text.length} chars in ${ms}ms`);
        console.log("\n--- preview (first 1500 chars) ---");
        console.log(text.slice(0, 1500));
        console.log("\n--- end preview ---");
    } catch (e) {
        console.log("✗ FAILED:", e.message);
    }
}

console.log("\nDONE");
