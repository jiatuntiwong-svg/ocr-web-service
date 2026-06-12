// POC 3 — word-extractor (specifically built for .doc files)
import WordExtractor from "word-extractor";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = [
    join(__dirname, "..", "poc-excel-extraction", "samples", "BKKA20721000.doc"),
    join(__dirname, "..", "poc-excel-extraction", "samples", "BKKFY3315800.doc"),
];

const extractor = new WordExtractor();

for (const filePath of SAMPLES) {
    const name = basename(filePath);
    console.log("\n" + "═".repeat(80));
    console.log(`FILE: ${name}`);
    console.log("═".repeat(80));

    try {
        const start = Date.now();
        const doc = await extractor.extract(filePath);
        const ms = Date.now() - start;
        const body = doc.getBody();
        console.log(`✓ Extracted ${body.length} chars in ${ms}ms`);
        console.log("\n--- body preview (first 2000 chars) ---");
        console.log(body.slice(0, 2000));
        console.log("\n--- end preview ---");

        const hdrs = doc.getHeaders();
        const ftrs = doc.getFooters();
        if (hdrs) console.log("\n--- headers ---\n" + hdrs.slice(0, 300));
        if (ftrs) console.log("\n--- footers ---\n" + ftrs.slice(0, 300));
    } catch (e) {
        console.log("✗ FAILED:", e.message);
    }
}

console.log("\nDONE");
