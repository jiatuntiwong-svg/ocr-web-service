# landscape-sibling-labels — OCR-6b regression fixture

**Class**: landscape page 1 + sibling labels in the same row
**Source doc (operator local, NOT committed — PII decision pending)**:
`TR07246900009- กาชาด 11.pdf` — form `ใบโอนย้ายสินทรัพย์ถาวร` (Thai Red Cross).
Page 1 is landscape, page 2 is portrait (photos only).

## Field under test

**Field name**: `ชื่อและรหัสศูนย์รับผิดชอบ`
**Expected value** (3 lines joined by `\n`):

```
3 6
ศูนย์รับบริจาคโลหิตและพลาสมา
สถานีกาชาดที่11 วิเศษนิยม บางแค
```

## Sibling labels in the same row (attention-blend risk)

The row contains 3 similar label+value groups side-by-side. Adjacent field
`รหัสสำนักงาน/ศูนย์` carries `ศูนย์บริการโลหิตแห่งชาติ`. Whole-image extraction
before OCR-6b returned `3 6 ศูนย์บริการโลหิตและพลาสมา` — a blend of the two
neighbors (borrowed `ศูนย์บริการ` from the sibling + `โลหิตและพลาสมา` from the
target), with line 3 dropped AND `รับบริจาค` silently autocorrected to
`บริการ`.

## Pass criteria

- Value contains all 3 lines listed above, joined by `\n`.
- Spelling matches verbatim (specifically `รับบริจาค`, not `บริการ`), OR the
  merged field carries a `corrections[]` entry documenting the transformation.
- No borrowing from sibling label `รหัสสำนักงาน/ศูนย์`.
- Merged field's raw_json must carry provenance (`source: "crop"` on success,
  or `crop_miss: true` / `crop_no_match: true` on failure — never absent).

## PDF commit decision

The source PDF contains staff names + other identifying information. Per the
TEST-1 PII policy (BOARD 2026-07-06), the file is **NOT** committed. Operator
must decide whether to (a) redact and commit, (b) store in R2 under a fixtures
prefix, or (c) keep local and run the regression manually. Until decided the
automated regression case below is inert (no fixture PDF at the expected path).

## Automated regression case

See `scripts/ocr-regression/cases/ocr-6b.json` — matches OCR-2 harness format.
Runs the moment `test_fixtures/regression/landscape-sibling-labels/source.pdf`
exists AND the harness credentials are in place.
