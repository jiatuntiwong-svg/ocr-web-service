# Knowledge Base — OCR SLM/AI Models (สำหรับอนาคต)

> **สถานะปัจจุบัน (2026-07-08):** ยังใช้ **Gemini เป็น base engine** — ยังไม่ลงทุน GPU
> เอกสารนี้เก็บความรู้ model ไว้สำหรับวันที่เงื่อนไขเปลี่ยน (ดู §3 Trigger)
> เทคนิคที่ใช้ได้ทันทีกับ Gemini อยู่ที่ [`OCR_IMPROVEMENT_TECHNIQUES_KB.md`](./OCR_IMPROVEMENT_TECHNIQUES_KB.md)

---

## 1. ตาราง Model Candidates

| Model | ขนาด | License (weights) | จุดเด่น | ตรงกับปัญหาเรา |
|---|---|---|---|---|
| **Typhoon OCR 1.5** (SCB 10X) | 2B/3B/7B | ✅ Apache 2.0 | สร้างเพื่อ**เอกสารไทย**โดยเฉพาะ (TH+EN), มี GGUF/QAT | เอกสารกาชาด/Thai form — จุดที่ Gemini variance + Chandra อ่อน |
| **dots.ocr 1.5** (rednote-hilab) | 1.7B | ✅ MIT | Layout JSON + **bbox ทุก text block**, olmOCR-bench 83.9 | Highlight accuracy (ปัญหายากสุดของ project) |
| **PaddleOCR-VL 1.6** (Baidu) | 0.9B | ✅ Apache 2.0 | เบามาก, 109 ภาษา (รวมไทย), OmniDocBench 96.3 | Layout layer / pre-filter หน้าเปล่า ราคาถูกสุด |
| **olmOCR 2** (Allen AI) | 7B | ✅ Apache 2.0 | bench 82.4, ecosystem เปิดทั้งหมด | Engine ที่สองไว้ cross-check |
| **DeepSeek-OCR-2** | 3B | ✅ Apache 2.0 | Throughput สูงมาก (~200k หน้า/วัน/A100) | Batch tier ราคาถูก |
| Chandra 2 (Datalab) | 5B | ⚠️ OpenRAIL-M | SOTA 85.9, forms/handwriting เด่น แต่ **Thai 62.6%** | ❌ ห้ามใช้แข่ง Datalab API — เราเป็น OCR SaaS |
| Surya 2 (Datalab) | - | ⚠️ OpenRAIL-M (<$5M) | Layout detection ดีมาก | ❌ ข้อจำกัดเดียวกับ Chandra |

**ข้อสรุป license:** ใช้ได้จริงใน production = Typhoon, dots.ocr, PaddleOCR-VL, olmOCR 2, DeepSeek-OCR-2
(ตรวจ license ซ้ำอีกครั้ง ณ วันที่จะใช้จริง — อาจเปลี่ยนได้)

## 2. Architecture ปลายทาง (เมื่อพร้อมลงทุน)

```
Document → Layout/bbox layer (dots.ocr หรือ PaddleOCR-VL)
         → Field extraction + reasoning (Gemini — ยังเป็น brain)
         → Verification เฉพาะ field ไทย confidence ต่ำ (Typhoon OCR)
         → Highlight ใช้พิกัด bbox จริง
```

หลักคิด: SLM ไม่ได้มาแทน Gemini แต่เป็น **layer เสริมเฉพาะจุดที่ Gemini อ่อน**
(ตำแหน่ง bbox, ภาษาไทย verbatim, cost ของ batch)

## 3. Trigger — เมื่อไหร่ควรกลับมาพิจารณา

| Trigger | สัญญาณวัด |
|---|---|
| ค่า Gemini/เดือน > ค่าเช่า GPU serverless | ดู AI usage dashboard (admin) |
| ปัญหา Thai verbatim/variance ยังไม่หายหลังทำ techniques KB ครบ | Regression suite pass rate |
| ติด rate limit 429 บ่อยจน block งาน batch ลูกค้า | `OCR_EXTRACTION_ERROR` logs |
| ลูกค้า enterprise ต้องการ data ไม่ออกนอกระบบ | Sales requirement |
| Highlight accuracy ต้องการ bbox จริง (pdf.js text layer ไม่พอสำหรับ scanned) | Compare feedback |

## 4. แนวทาง POC โดยไม่ซื้อ GPU

- เช่า **serverless GPU จ่ายต่อวินาที** (Modal / RunPod) — POC จบใน budget หลักร้อยบาท
- Typhoon OCR มี GGUF → ทดสอบบน CPU/เครื่อง dev ได้เลย (ช้าแต่พอวัด accuracy)
- ชุดทดสอบ: regression fixtures 5 ตัว + เอกสารกาชาดจริง 3 ฉบับ × 3 runs
  เทียบ Gemini baseline ใน `OCR_TESTING_LOG.md`
- เกณฑ์ผ่าน: Thai verbatim ≥ Gemini และ variance ต่ำกว่า

---

## References

- [Typhoon OCR — GitHub](https://github.com/scb-10x/typhoon-ocr) · [HF 1.5-2b](https://huggingface.co/scb10x/typhoon-ocr1.5-2b)
- [dots.ocr — HF](https://huggingface.co/rednote-hilab/dots.ocr)
- [PaddleOCR-VL — HF](https://huggingface.co/PaddlePaddle/PaddleOCR-VL)
- [olmOCR-2 — HF](https://huggingface.co/allenai/olmOCR-2-7B-1025)
- [DeepSeek-OCR-2 — HF](https://huggingface.co/deepseek-ai/DeepSeek-OCR-2)
- [Chandra 2 — HF](https://huggingface.co/datalab-to/chandra-ocr-2) (license reference)
- [HF blog: OCR open models](https://huggingface.co/blog/ocr-open-models)
