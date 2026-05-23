#!/usr/bin/env python3
"""
Standalone document extraction via Gemini API.

Use this script when you want to send a document + field list + prompt
directly to Gemini and receive structured JSON back, without depending on
this web app's API routes.

Example:
    python document_extract_gemini.py ^
      --file invoice.pdf ^
      --field "Invoice Number" ^
      --field "Invoice Date" ^
      --field "VAT" ^
      --field "Grand Total"

Or:
    python document_extract_gemini.py ^
      --file invoice.jpg ^
      --fields "Invoice Number,Invoice Date,VAT,Grand Total" ^
      --instruction "Extract only the listed fields."

Environment:
    GEMINI_API_KEY=your_api_key
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "gemini-2.5-flash"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a document and field list to Gemini and return strict JSON."
    )
    parser.add_argument("--file", required=True, help="Path to PDF/image document")
    parser.add_argument("--api-key", help="Gemini API key, defaults to GEMINI_API_KEY")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model (default: {DEFAULT_MODEL})")
    parser.add_argument("--field", action="append", default=[], help="Field to extract. Repeatable.")
    parser.add_argument("--fields", help="Comma-separated list of fields to extract.")
    parser.add_argument(
        "--instruction",
        default="Extract only the requested fields and return strict JSON.",
        help="Extra extraction instruction.",
    )
    parser.add_argument(
        "--output",
        help="Optional path to save the JSON response.",
    )
    return parser.parse_args()


def build_field_list(args: argparse.Namespace) -> list[str]:
    fields = list(args.field or [])
    if args.fields:
        fields.extend([item.strip() for item in args.fields.split(",") if item.strip()])
    fields = [item for item in fields if item]
    if not fields:
        raise ValueError("At least one field is required. Use --field or --fields.")
    return fields


def guess_mime_type(file_path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(str(file_path))
    return mime_type or "application/octet-stream"


def build_prompt(fields: list[str], instruction: str) -> str:
    field_lines = "\n".join(f'- "{field}"' for field in fields)
    schema = ",\n".join(f'    "{field}": null' for field in fields)
    return f"""You are a document extraction engine.

Task:
- Read the attached document.
- Extract only the fields listed below.
- If a field is missing, return null.
- Do not invent extra fields.
- Return valid JSON only.

Requested fields:
{field_lines}

Additional instruction:
{instruction}

Required JSON shape:
{{
  "fields": {{
{schema}
  }}
}}
"""


def call_gemini(api_key: str, model: str, file_bytes: bytes, mime_type: str, prompt: str) -> str:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(api_key)}"
    )

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": base64.b64encode(file_bytes).decode("utf-8"),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
        },
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read().decode("utf-8")

    parsed = json.loads(raw)
    candidates = parsed.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {raw}")

    parts = candidates[0].get("content", {}).get("parts", [])
    texts = [part.get("text", "") for part in parts if part.get("text")]
    if not texts:
        raise RuntimeError(f"Gemini returned no text output: {raw}")

    return "\n".join(texts).strip()


def extract_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def main() -> int:
    args = parse_args()
    file_path = Path(args.file)
    if not file_path.exists():
        print(f"File not found: {file_path}", file=sys.stderr)
        return 1

    api_key = args.api_key or os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("Missing Gemini API key. Set GEMINI_API_KEY or use --api-key", file=sys.stderr)
        return 1

    try:
        fields = build_field_list(args)
        mime_type = guess_mime_type(file_path)
        file_bytes = file_path.read_bytes()
        prompt = build_prompt(fields, args.instruction)

        response_text = call_gemini(
            api_key=api_key,
            model=args.model,
            file_bytes=file_bytes,
            mime_type=mime_type,
            prompt=prompt,
        )
        result = extract_json(response_text)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}: {error_body}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 3

    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)

    if args.output:
        Path(args.output).write_text(rendered, encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
