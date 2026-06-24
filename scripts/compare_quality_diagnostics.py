#!/usr/bin/env python3
"""Compare Python and Rust quality diagnostic JSON output."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: str) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as file:
        return json.load(file)


def candidate_signature(candidate: dict[str, Any]) -> tuple[Any, ...]:
    return (
        candidate.get("height"),
        candidate.get("metric"),
        bool(candidate.get("is_h264")),
        bool(candidate.get("is_quality_candidate")),
        bool(candidate.get("is_download_addr")),
        bool(candidate.get("is_lowbr")),
        bool(candidate.get("is_watermark")),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare quality diagnostic JSON files.")
    parser.add_argument("python_json")
    parser.add_argument("rust_json")
    args = parser.parse_args()

    python_data = load_json(args.python_json)
    rust_data = load_json(args.rust_json)
    differences: list[dict[str, Any]] = []

    for key in ("aweme_id", "selected_url", "supported_heights"):
        if python_data.get(key) != rust_data.get(key):
            differences.append({
                "field": key,
                "python": python_data.get(key),
                "rust": rust_data.get(key),
            })

    python_candidates = [candidate_signature(item) for item in python_data.get("candidates", [])]
    rust_candidates = [candidate_signature(item) for item in rust_data.get("candidates", [])]
    if python_candidates != rust_candidates:
        differences.append({
            "field": "candidate_signatures",
            "python_count": len(python_candidates),
            "rust_count": len(rust_candidates),
            "python_only": [item for item in python_candidates if item not in rust_candidates],
            "rust_only": [item for item in rust_candidates if item not in python_candidates],
        })

    result = {
        "match": not differences,
        "differences": differences,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not differences else 1


if __name__ == "__main__":
    raise SystemExit(main())
