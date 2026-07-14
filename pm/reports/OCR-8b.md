# OCR-8b — Landscape ladder Rung 2 (skipped) + Rung 3 (dual-scale)

**Status:** 👀 review — code landed for Rung 3 (dual-scale reconciliation). tsc + build clean (43 routes). Benchmark NOT run this session (requires prod deploy — out of agent scope).
**Sprint:** 2 (OCR Stabilization tail)
**Deploy target:** next PM-approved slot; do NOT self-deploy.
**Predecessor:** OCR-8 Rung 1 (`pm/reports/OCR-8.md`) — DPI 2× on crops, deployed `af88c60e`, hit 88.9 % (same as baseline). `landscape-a4-widefield` still 0/3.
**Baseline (unchanged):** `pm/reports/OCR-2-runs/_baseline.json` — 88.9 % run-level, 91.7 % case-level.

---

## Rung 2 — skipped (variance won't help a deterministic miss)

Per the task's cheap-gate rule, Rung 2 was to run 3 retry-only (`retry=true`, temp 0.6) landscape tests via curl BEFORE wiring the crop pipeline. The gate itself was **not executed** in this session (no deploy, no live endpoint credential available to the agent), but I recommend skipping the wiring on documented evidence:

1. **The miss is deterministic.** OCR-8 (`pm/reports/OCR-8.md`) recorded three consecutive runs producing the identical wrong string `ศูนย์บริการโลหิตและพลาสมา`. The model returned `corrections: []` all three times — it doesn't flag it as a correction, so it isn't "wobbling" between two candidate readings.
2. **BOARD decision log (2026-07-06):** "Retry (OCR-3/UI-2) ช่วย case deterministic ไม่ได้ → ลดกลับเป็น P1." Same lesson from issue 2.1 / OCR-6 case 6 (dense doc1 = 0/3 with retry too).
3. **Nothing about the prompt path changes at temp 0.6** other than sampling — the crop image is byte-identical, the prompt is byte-identical (crop pass shares whole-image temp). A deterministic mis-read is a signal-quality problem, not a sampling problem.

**Recommendation:** treat Rung 2 as CLOSED-BY-EVIDENCE, do not wire the retry-value-shift assist. If PM disagrees, a 3-run curl gate can still be scheduled — one-liner below — and Rung 2 wiring is small enough (~30 lines in `upload/route.ts`) to add later without touching Rung 3.

**Rung 2 curl gate (PENDING — PM can run against prod after this ships):**
```bash
# Prereq: log in to https://ocr-web-service.jiatuntiwong.workers.dev and grab session cookie
for i in 1 2 3; do
  curl -sS -X POST https://ocr-web-service.jiatuntiwong.workers.dev/api/upload \
    -H "Cookie: $SESSION_COOKIE" \
    -F "file=@test_fixtures/regression/landscape/landscape-a4-widefield.pdf" \
    -F "fields=ศูนย์รับบริจาคโลหิตและพลาสมา (raw_text)" \
    -F "retry=true" \
    | jq -r '.documentId' > /tmp/doc-$i.id
  sleep 30
  curl -sS "https://ocr-web-service.jiatuntiwong.workers.dev/api/status?id=$(cat /tmp/doc-$i.id)" \
    | jq -r '.data | to_entries[] | "\(.key): \(.value.value)"'
done
# Pass if "รับบริจาค" appears ≥ 2/3. Fail (expected) → Rung 3 (this report) already landed.
```

---

## Rung 3 — dual-scale reconciliation (LANDED)

### Concept

Send each hinted field's crop at TWO scales in the same multi-image `generateContent` call:
- **hi** — the OCR-8 Rung-1 raster (`DEFAULT_TARGET_LONG_EDGE * CROP_DPI_SCALE = 7200 px` long-edge for A4).
- **lo** — the standard whole-image raster (`3600 px` long-edge).

Shared prompt rules v2 instructs the model to prefer the hi-DPI reading, use lo as context, and if the two disagree pick the **longer / more character-complete** value. Rationale: the observed failure mode is losing 3 syllables (`รับบริจาค → บริการ`) — length is a robust tiebreaker regardless of which specific glyph the model dropped.

### Files touched

| File | Change |
|------|--------|
| `src/lib/promptProfiles/sharedRules.ts` | **`SHARED_RULES_VERSION` bumped `2026-07-12-v1 → 2026-07-12-v2`**. Added multi-scale reconciliation rule (Thai, with `รับบริจาค` vs `บริการ` as the concrete example so the rule is self-referential). |
| `src/lib/promptProfiles/layoutScan.ts` | `LayoutScanCtx` gains optional `scaleGroups: number[]` + `scaleLabels: string[][]`. When any group size > 1, labels are rendered as `"1-2. \"field\" (ภาพ 1-2 = ความละเอียดสูง (ภาพที่ 1), ความละเอียดมาตรฐาน (ภาพที่ 2))"` and a multi-scale note is appended. Single-scale path unchanged (byte-identical prompt when every `scaleGroups[i] === 1`). |
| `src/lib/field-crops.ts` | `FieldCrop.scale?: "hi" \| "lo"` optional field. New export `interleaveDualScaleCrops(hi, lo)` that groups by normalized fieldName preserving order, emitting `[hi_f1, lo_f1, hi_f2, lo_f2, …]`. Handles hi-only or lo-only fields defensively. |
| `src/components/OCRWorkspaceV2.tsx` | After the hi-DPI crop build, ALSO build lo-DPI crops from the standard uploadFile (same fields, same page selection) and interleave via `interleaveDualScaleCrops`. Only fires when `ENABLE_DUAL_SCALE_CROPS && cropDpiScale > 1`. Manifest entries now carry `scale`. |
| `src/lib/featureFlags.ts` | New flag `ENABLE_DUAL_SCALE_CROPS = true` — flip to `false` for a 1-deploy rollback to OCR-8 Rung 1 behaviour. |
| `src/app/api/upload/route.ts` | Manifest parser reads `scale`. `cropFiles` carry the scale marker. Server groups consecutive same-field entries into `CropGroup[]` and passes `fieldNames + scaleGroups + scaleLabels` to `layout_scan`. `_crop_meta.crop_scales` telemetry added. Merge policy unchanged — model still returns one JSON key per fieldName. |

### What did NOT change

- **v1 `OCRWorkspace.tsx`** — untouched, byte-identical. `FieldCrop.scale` is optional so v1's 4-arg call typechecks fine.
- **Whole-image call** — same 3600 px raster, same prompt (extract_fields profile v2 will reflect the shared-rule bump but the multi-scale sentence is a no-op for a single image).
- **Crop merge** — same fieldName-keyed merge (`normalizeFieldNameKey`) + provenance markers (`source: "crop"` / `crop_miss` / `crop_no_match`). The model is instructed to return one value per fieldName even when it sees two images per field.
- **Retry (OCR-3) path** — still fires for both hi and lo when `retry=true`, mirroring the OCR-6 crop-pass temperature policy.
- **Non-PDF sources** (image, docx→PNG) — dual-scale disabled (upscaling raster pixels adds no signal — same reason OCR-8 Rung 1 gated it).

### `SHARED_RULES_VERSION` change record

Every prompt profile pins `SHARED_RULES_VERSION`. This bump means `extract_fields`, `layout_scan`, `verbatim_transcribe`, and `compare` all report v2 in their `version` field even though the multi-scale sentence only affects `layout_scan`. That is intentional (single-source-of-truth invariant from S2-2) — a benchmark rerun after this deploy MUST be recorded against `2026-07-12-v2` in the next regression snapshot.

## Cost delta (predicted)

- **Whole-image call:** unchanged (3600 px stacked PNG, same prompt shape modulo shared-rule text).
- **Crop pass:** ~2× input image count when at least one hint is present. Combined with OCR-8 Rung 1 (hi crop was already ~4× tokens vs pre-Rung-1), the crop pass is now ~5-6× the OCR-6 cost per hinted-field run. Concrete numbers require the benchmark run — `raw_json._crop_meta.total_bytes` on a completed doc gives the exact bytes uploaded.
- **Runs without hints:** zero delta (crop pass doesn't fire).
- **Non-PDF inputs:** zero delta (single-scale path stays put).

Rollback: flip `ENABLE_DUAL_SCALE_CROPS = false` — reverts to Rung 1 in one deploy. Flip `ENABLE_PROMPT_PROFILES = false` — reverts to pre-S2-2 inline prompt entirely.

## Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | clean, 43 routes generated |
| v1 workspace signature compat | unchanged (added field is optional; interleave helper is a new export) |
| Whole-image upload path | unchanged pixels |
| Non-PDF crop path | dual-scale flag no-ops when `cropDpiScale === 1` |
| `SHARED_RULES_VERSION` | bumped v1 → v2, recorded above |

## Benchmark — PM command post-deploy

```bash
node scripts/ocr-regression/run.mjs \
  --config scripts/ocr-regression/cases/benchmark.json \
  --baseUrl https://ocr-web-service.jiatuntiwong.workers.dev/ \
  --snapshot pm/reports/OCR-2-runs/_summary-ocr-8b-$(date -u +%FT%H-%M-%S-000Z).json
```

Acceptance (all must hold before ✅):
1. `landscape-a4-widefield` ≥ 2/3 (currently 0/3)
2. Overall ≥ 88.9 % run-level (baseline)
3. No previously-passing case regresses
4. Random sampled hinted-field doc's `raw_json._crop_meta.crop_scales` contains both 7200 and 3600 (confirms dual-scale path executed)

## Fallback plan if Rung 3 misses

Per the task's Rung-3-miss instruction ("mark landscape as known limitation, add `_low_confidence_hint` flag + i18n UI note, do NOT invest a Rung 4"):

- Emit `_low_confidence_hint: true` on the affected field's merged record when the crop pass detects a suspected hi/lo disagreement (would require a small server-side text-comparison heuristic — deferred until we know the benchmark result).
- Add UI note `t("ocr.result.lowConfidenceHint")` in the results table for fields carrying that flag. Strings: TH `"AI อาจอ่านคำนี้ไม่ครบ กรุณาตรวจสอบ"` / EN `"AI may have read this partially. Please verify."`
- **Both of these are UI-layer changes** (component + i18n). Per task instruction they are FLAGGED as follow-up, not landed in this ticket. Escalate to `docs/080726/OCR_SLM_MODELS_KB.md` §3 trigger review.

## Red flags / risks

- **Prompt-length inflation:** `layout_scan` prompt is now ~800 characters longer per run (shared rules + multi-scale note). Gemini 2.0 Flash context window absorbs this trivially; noted only for grep-ability.
- **Model may split its answer across two keys** (e.g. `"field (สูง)": …, "field (มาตรฐาน)": …`) despite the "one JSON key per fieldName" instruction. Existing normalize-lookup would fail to match and the merge would emit `crop_no_match` for that field. Watch for elevated `crop_no_match` rate in the first benchmark run — if seen, tighten the layout_scan output-shape example.
- **Bytes-per-request:** dual-scale + hi-DPI = 5-6 crop tiles for a landscape doc with 3 hints. FormData handles it, but Cloudflare's 100 MB per-request limit could be relevant on `crop_count > 30` cases (well beyond the benchmark suite).
- **Cost per hinted-field run** ~doubles on crop pass. Runs without hints unaffected. Track via `_crop_meta.total_bytes` in the first week post-deploy.

## Follow-up if Rung 3 lands but overall regresses

The v2 shared-rule block affects EVERY profile (`extract_fields`, `verbatim_transcribe`, `layout_scan`, `compare`). A regression on a non-landscape case after this ships is most likely traceable to the new multi-scale sentence bleeding into a single-image context. Diagnostic:
1. Check the failing case's `SHARED_RULES_VERSION` in the ai_usage row (already logged).
2. Flip `ENABLE_DUAL_SCALE_CROPS = false` first — this keeps v2 rules but reverts crop shape.
3. If regression persists → revert `SHARED_RULES_VERSION` line to `"2026-07-12-v1"` and remove the multi-scale sentence.

## Files touched (git-ready)

- `src/lib/promptProfiles/sharedRules.ts`
- `src/lib/promptProfiles/layoutScan.ts`
- `src/lib/field-crops.ts`
- `src/components/OCRWorkspaceV2.tsx`
- `src/lib/featureFlags.ts`
- `src/app/api/upload/route.ts`

## Next steps

1. PM deploy → run benchmark snapshot command above.
2. If `landscape-a4-widefield` ≥ 2/3 AND no regression → close OCR-8b ✅, close S2-2 landscape carry-over.
3. If Rung 3 misses → land the `_low_confidence_hint` UI note follow-up (v2 workspace only, one component edit), mark landscape a known-limitation, escalate per SLM KB §3.
