-- Per-user default template selection. Auto-applied when the user opens
-- OCR or Compare so they don't have to pick the same template every session.
-- Both columns are nullable — a NULL means "use the built-in starter fields".

ALTER TABLE users ADD COLUMN default_ocr_template_id TEXT REFERENCES templates(id);
ALTER TABLE users ADD COLUMN default_compare_template_id TEXT REFERENCES templates(id);
