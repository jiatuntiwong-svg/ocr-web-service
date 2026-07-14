# OCR-8 — Crop legibility (Rung 1: DPI bump)

**Status:** 👀 review — code landed, tsc + build clean (43 routes). Benchmark NOT run in this session (requires prod deploy, out of scope for the agent).
**Sprint:** 2 (OCR Stabilization tail)
**Deploy target:** next PM-approved slot; do NOT self-deploy.
**Baseline:** `pm/reports/OCR-2-runs/_baseline.json` — 88.9% run-level, 91.7% case-level; `landscape-a4-widefield` 0/3, `dense-22-row-table` 2/3, `verbatim-plastelet` 3/3 (once timeout flake removed).

## Decision — ship only Rung 1

Per the task's "STOP at the first rung that hits ≥ 2/3" instruction, code changes are the DPI bump ONLY. Rungs 2 (retry-at-0.6 assist) and 3 (dual-scale re-crop) are deferred to a follow-up if the benchmark rerun does not clear 2/3 on `landscape-a4-widefield`. This keeps token-cost delta bounded (crop pass ≈ 4× tokens, whole-image call unchanged) and avoids `SHARED_RULES_VERSION` churn. `sharedRules.ts` untouched — version unchanged.

## Changes

### Vision path
- **`src/lib/pdf-to-image.ts`**
  - Exported `DEFAULT_TARGET_LONG_EDGE = 3600` (previously an inline literal).
  - New optional `PdfRasterOptions.maxScale` (default `4`). Without it, base A4 pages (longEdge ≈ 842 pt) clamp at 4× → ~3368 px, never reaching a 7200 px target.
- **`src/lib/field-crops.ts`**
  - Added `FieldCrop.bytes` (blob size for cost telemetry).
  - Exported `CROP_DPI_SCALE = 2`.
- **`src/components/OCRWorkspaceV2.tsx` (`prepareUploadWithCrops`)**
  - When source is PDF and at least one field has `bbox_hint`, do a **second** `pdfFileToImageDetailed()` call at `targetLongEdge = 3600 × CROP_DPI_SCALE (=7200)`, `maxScale = 8`, restricted to the rendered pages. Whole-image upload keeps the standard 3600 px raster — only the crop tiles carry the extra pixels.
  - Non-PDF sources (image/docx→PNG) fall back to `dpiScale = 1` (upscaling raster pixels adds no signal).
  - New field `cropDpiScale` in the return type, forwarded to the upload FormData.
- **`src/app/api/upload/route.ts`**
  - Reads `crop_dpi_scale` FormData field (default 1).
  - Manifest entries now carry optional `bytes`.
  - On success, attaches `extracted._crop_meta = { dpi_scale, total_bytes, crop_count }` to `raw_json` — observational only, no logic depends on it.
- **v1 workspace (`OCRWorkspace.tsx`) untouched** (frozen). `buildFieldCrops` signature is a superset — v1's 4-arg call still typechecks.

### Harness robustness
- **`scripts/ocr-e2e/harness.mjs`**
  - JSON-tab wait bumped 120 s → 180 s. `verbatim-plastelet` occasionally exceeds 120 s because the crop pass is a second Gemini call.
  - Selector loosened: `/^JSON( raw)?$/i` so a future label rename ("JSON raw" → "JSON") does not silently break the harness.

## Cost delta (predicted)

- Whole-image call: **unchanged** (still 3600 px stacked PNG).
- Crop pass: each crop tile carries ~4× the pixel count → Gemini image tokens rise roughly linearly with pixel count for image-tokens accounting. Empirical measurement waits on the benchmark run — `_crop_meta.total_bytes` on any completed doc's `raw_json` gives the concrete number.
- Runs without hints: **zero delta** (crop pass does not fire).
- Non-PDF inputs: **zero delta** (raster stays at native resolution).

## Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | clean, 43 routes generated |
| v1 workspace signature compat | unchanged (superset) |
| Whole-image upload path | unchanged pixels |
| Non-PDF crop path | unchanged (dpiScale=1 fallback) |
| SHARED_RULES_VERSION | not bumped (no prompt/rule change) |

## Benchmark — command for PM to run post-deploy

```bash
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json \
  --baseUrl https://ocr-web-service.jiatuntiwong.workers.dev/ \
  --snapshot pm/reports/OCR-2-runs/_summary-ocr-8-$(date -u +%FT%H-%M-%S-000Z).json
```

Acceptance (all must hold before mark ✅):
1. `landscape-a4-widefield` ≥ 2/3 (currently 0/3)
2. Overall ≥ 88.9 % run-level (baseline)
3. No previously-passing case regresses
4. Random sampled doc's `raw_json._crop_meta.dpi_scale === 2` (confirms path took the new branch)

## If Rung 1 misses acceptance

Follow-up ticket OCR-8b — Rung 2 (retry-at-0.6 value-shift signal) then Rung 3 (dual-scale re-crop + `sharedRules.ts` reconciliation rule + `SHARED_RULES_VERSION` bump). Kept out of this landing to keep the diff bisectable.

## Red flags / risks

- **Memory:** high-DPI render at 8× scale on Cloudflare workerd is client-side (`pdfjs-dist` in browser), so Worker memory is unaffected. Client-side memory on landscape A4 at 7200 px longEdge ≈ 51 MP × 4 bytes = ~200 MB canvas — likely fine on desktop, could OOM on low-RAM mobile. If observed in the wild, gate `CROP_DPI_SCALE` behind a device-memory check.
- **Latency:** a second pdfjs raster adds ~1-2 s per run before the upload starts. UI stays on the same "converting…" step.
- **Blob size ceiling:** individual crop PNGs at 2× can exceed a few MB. FormData path handles it fine but check Cloudflare's request-size limit if a doc has many hinted fields (`crop_count > 20`). Unchanged limit was `MAX_UPLOAD_SIZE_MB = 20` and only guards the primary file, not attached parts — worth watching, not blocking.

## Files touched

- `src/lib/pdf-to-image.ts`
- `src/lib/field-crops.ts`
- `src/components/OCRWorkspaceV2.tsx`
- `src/app/api/upload/route.ts`
- `scripts/ocr-e2e/harness.mjs`
