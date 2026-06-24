#!/usr/bin/env python3
"""Diagnose Douyin video quality candidates and final URL ordering."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.api.api import DouyinAPI
from src.config.config import Config
from src.downloader.downloader import DouyinDownloader
from src.user.user_manager import DouyinUserManager


def extract_aweme_id(value: str) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"\d{10,}", text):
        return text
    for pattern in (r"/video/(\d+)", r"/note/(\d+)", r"aweme_id=(\d+)", r"modal_id=(\d+)"):
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return ""


async def resolve_video(manager: DouyinUserManager, source: str) -> dict:
    aweme_id = extract_aweme_id(source)
    if aweme_id:
        detail = await manager.get_video_detail(aweme_id)
        if detail:
            return detail
        raise RuntimeError(f"无法获取视频详情: {aweme_id}")

    parsed = await manager.parse_share_link(source)
    if isinstance(parsed, dict) and parsed.get("aweme_id"):
        return parsed
    raise RuntimeError("无法从输入中解析 aweme_id 或视频详情")


def build_diagnostic(manager: DouyinUserManager, video: dict, quality: str) -> dict:
    original_quality = Config.DOWNLOAD_QUALITY
    Config.DOWNLOAD_QUALITY = Config.normalize_download_quality(quality or original_quality)
    video_data = video.get("video") or {}
    try:
        candidates = manager._collect_video_candidates(video_data)
        ordered_urls = manager.get_video_download_urls(video_data)
    finally:
        Config.DOWNLOAD_QUALITY = original_quality
    selected_url = ordered_urls[0] if ordered_urls else ""
    selected = next((candidate for candidate in candidates if candidate.get("url") == selected_url), None)
    supported_heights = sorted({
        int(candidate.get("height") or 0)
        for candidate in candidates
        if not candidate.get("is_watermark")
        and not candidate.get("is_download_addr")
        and not candidate.get("is_lowbr")
        and int(candidate.get("height") or 0) > 0
    })

    return {
        "aweme_id": video.get("aweme_id") or video.get("itemId") or "",
        "requested_quality": Config.normalize_download_quality(quality or original_quality),
        "configured_quality": Config.DOWNLOAD_QUALITY,
        "selected_url": selected_url,
        "selected": selected,
        "supported_heights": supported_heights,
        "ordered_urls": ordered_urls,
        "candidates": candidates,
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose video quality candidates.")
    parser.add_argument("source", help="Douyin share URL or aweme_id")
    parser.add_argument("--cookie", default="", help="Override Config.COOKIE")
    parser.add_argument("--quality", default="", help="Label the requested quality in output")
    parser.add_argument("--format", choices=("json", "plain"), default="json")
    args = parser.parse_args()

    cookie = args.cookie or Config.COOKIE
    api = DouyinAPI(cookie)
    downloader = DouyinDownloader(api)
    manager = DouyinUserManager(api, downloader)
    video = await resolve_video(manager, args.source)
    diagnostic = build_diagnostic(manager, video, args.quality or Config.DOWNLOAD_QUALITY)

    if args.format == "plain":
        print(f"aweme_id: {diagnostic['aweme_id']}")
        print(f"requested_quality: {diagnostic['requested_quality']}")
        print(f"supported_heights: {', '.join(map(str, diagnostic['supported_heights']))}")
        print(f"selected_url: {diagnostic['selected_url']}")
        print(f"candidate_count: {len(diagnostic['candidates'])}")
    else:
        print(json.dumps(diagnostic, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
