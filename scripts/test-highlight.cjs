// Standalone test for highlight matcher against real OCR tokens.
// Compiles text-extractor.ts to CJS on the fly, runs Tesseract on the PNG,
// then exercises matchValueToTokens with hand-picked invoice values.

const fs = require("fs");
const path = require("path");
const os = require("os");
const ts = require("typescript");

// Use text-extractor for OCR (Node-only) but matchers come from text-matcher
// via the re-export in text-extractor.ts.
const SRC = path.resolve("src/lib/text-extractor.ts");
const MATCHER_SRC = path.resolve("src/lib/text-matcher.ts");
const OUT = path.resolve(".text-extractor-cjs.tmp.js");

function compileTs(srcPath, outPath) {
    const code = fs.readFileSync(srcPath, "utf8");
    const compiled = ts.transpileModule(code, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            skipLibCheck: true,
        },
    });
    const patched = compiled.outputText
        .replace('require("./types")', '{}')
        .replace(/require\(["']\.\/text-matcher["']\)/g, `require(${JSON.stringify(MATCHER_OUT)})`);
    fs.writeFileSync(outPath, patched);
}

const MATCHER_OUT = path.resolve(".text-matcher-cjs.tmp.js");
compileTs(MATCHER_SRC, MATCHER_OUT);
compileTs(SRC, OUT);

const extractor = require(OUT);

async function main() {
    const imgPath = "C:/Users/User/OneDrive/OCR/TestINV.PNG";
    if (!fs.existsSync(imgPath)) throw new Error("file not found: " + imgPath);

    const buffer = fs.readFileSync(imgPath);
    console.log("==> Image size:", buffer.length, "bytes");

    console.log("==> Running Tesseract OCR (tha+eng)... (this may take ~30s)");
    const tokens = await extractor.extractDocumentTokens(buffer.buffer.slice(
        buffer.byteOffset, buffer.byteOffset + buffer.byteLength
    ), "image/png");
    console.log("==> OCR tokens extracted:", tokens.length);
    if (tokens.length === 0) {
        console.error("!! No tokens — OCR may have failed silently");
        return;
    }

    // Sample of tokens
    console.log("==> First 8 tokens:");
    tokens.slice(0, 8).forEach((t, i) =>
        console.log(`  [${i}] "${t.text}" x=${t.x.toFixed(3)} y=${t.y.toFixed(3)} w=${t.width.toFixed(3)} h=${t.height.toFixed(3)}`)
    );

    // Test cases — value (doc1), counterpart values (doc2..) so we can verify
    // disambiguation behavior. We compare TestINV with itself = all same =
    // no diff expected. We still exercise the matcher on each value to verify
    // it finds the correct location with high confidence.
    const cases = [
        { label: "PO number",    value: "PO-2026-0042", counterparts: ["PO-2026-0042"], isTable: false },
        { label: "Buyer tax id", value: "0105555555555", counterparts: ["0105555555555"], isTable: false },
        { label: "Vendor tax id (repeated digit pattern)", value: "0106666666666", counterparts: ["0106666666666"], isTable: false },
        { label: "Date Thai",    value: "15 มีนาคม 2026", counterparts: ["15 มีนาคม 2026"], isTable: false },
        { label: "Payment term Thai", value: "เครดิต 30 วัน", counterparts: ["เครดิต 30 วัน"], isTable: false },
        { label: "Grand total",  value: "79,180.00", counterparts: ["79,180.00"], isTable: false },
        { label: "Subtotal (different number)", value: "74,000.00", counterparts: ["74,000.00"], isTable: false },
        { label: "Table rows",   value: "IT-L01 Laptop Dell Latitude 5420 2 เครื่อง 35,000.00 70,000.00\nIT-M05 Wireless Mouse Logitech M330 5 ชิ้น 500.00 2,500.00", counterparts: ["IT-L01 Laptop Dell Latitude 5420 2 เครื่อง 35,000.00 70,000.00\nIT-M05 Wireless Mouse Logitech M330 5 ชิ้น 500.00 2,500.00"], isTable: true },
        // Repeated-value disambiguation: choose the one near label
        { label: "Repeated digit (only 10)", value: "10110", counterparts: ["10110"], isTable: false }, // postcode buyer
        { label: "Disambig postcode 10400 vs 10110", value: "10400", counterparts: ["10110"], isTable: false },
        { label: "Disambig vendor name vs buyer", value: "บริษัท ผู้จำหน่ายใจดี จำกัด", counterparts: ["บริษัท ทดสอบระบบ จำกัด"], isTable: false },
    ];

    console.log("\n==> Match tests:");
    for (const tc of cases) {
        const r = extractor.matchValueToTokens(tc.value, tokens, tc.isTable, tc.counterparts);
        const merged = extractor.mergeTokenBoxes(r.tokens);
        console.log(`\n--- ${tc.label} ---`);
        console.log(`  value: ${JSON.stringify(tc.value)}`);
        console.log(`  matched tokens: ${r.tokens.length}, confidence: ${r.confidence.toFixed(3)}, merged boxes: ${merged.length}`);
        if (merged.length > 0) {
            merged.slice(0, 6).forEach((b, i) =>
                console.log(`    box[${i}] page=${b.page} x=${b.x.toFixed(3)} y=${b.y.toFixed(3)} w=${b.width.toFixed(3)} h=${b.height.toFixed(3)} text="${b.text.slice(0, 60)}"`)
            );
        }
    }
}

main().catch(e => { console.error("ERR:", e); process.exit(1); });
