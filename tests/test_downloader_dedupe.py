import os

from src.config.config import Config
from src.downloader.downloader import DouyinDownloader, build_download_name, _is_dash_video_only_url
from src.user.user_manager import DouyinUserManager


def _user_manager():
    manager = DouyinUserManager.__new__(DouyinUserManager)
    manager.debug_mode = False
    return manager


def test_download_quality_aliases_are_normalized():
    assert Config.normalize_download_quality("2160p") == "4k"
    assert Config.normalize_download_quality("1440p") == "2k"
    assert Config.normalize_download_quality("p1080") == "1080p"
    assert Config.normalize_download_quality("unknown") == "auto"


def test_dedupe_extracts_only_protected_aweme_suffix(tmp_path):
    original_dir = Config.DOWNLOAD_DIR
    Config.DOWNLOAD_DIR = str(tmp_path)
    try:
        downloader = DouyinDownloader(api=None)
        assert (
            downloader._extract_downloaded_aweme_id("标题123456789012_7380011223344556677.mp4")
            == "7380011223344556677"
        )
        assert (
            downloader._extract_downloaded_aweme_id("标题_7380011223344556677_02.jpg")
            == "7380011223344556677"
        )
        assert downloader._extract_downloaded_aweme_id("标题123456789012.mp4") == ""
    finally:
        Config.DOWNLOAD_DIR = original_dir


def test_dedupe_ignores_partial_and_tiny_files(tmp_path):
    original_dir = Config.DOWNLOAD_DIR
    Config.DOWNLOAD_DIR = str(tmp_path)
    try:
        downloader = DouyinDownloader(api=None)
        partial = tmp_path / "标题_7380011223344556677.mp4.tmp"
        partial.write_bytes(b"x" * 8192)
        tiny = tmp_path / "标题_7380011223344556677.mp4"
        tiny.write_bytes(b"x")
        complete = tmp_path / "标题_7380011223344556678.mp4"
        complete.write_bytes(os.urandom(8192))

        assert not downloader._is_complete_download_file(str(tmp_path), partial.name)
        assert not downloader._is_complete_download_file(str(tmp_path), tiny.name)
        assert downloader._is_complete_download_file(str(tmp_path), complete.name)
    finally:
        Config.DOWNLOAD_DIR = original_dir


def test_unique_filepath_uses_readable_copy_number(tmp_path):
    downloader = DouyinDownloader(api=None)
    (tmp_path / "clip.mp4").write_bytes(b"existing")
    (tmp_path / "clip_2.mp4").write_bytes(b"existing")

    result = downloader._unique_filepath(str(tmp_path), "clip", "mp4")

    assert result.endswith("clip_3.mp4")
    assert "178" not in os.path.basename(result)


def test_author_name_with_asterisk_is_sanitized_before_download(tmp_path):
    original_dir = Config.DOWNLOAD_DIR
    Config.DOWNLOAD_DIR = str(tmp_path)
    try:
        download_name = build_download_name("作者*星号", "标题", "7380011223344556677")
        assert "*" not in download_name
        assert download_name.startswith("作者_星号/")

        downloader = DouyinDownloader(api=None)
        user_dir, filename = downloader._split_download_name("作者*星号/标题*正文_7380011223344556677")
        assert user_dir == "作者_星号"
        assert filename == "标题_正文_7380011223344556677"
    finally:
        Config.DOWNLOAD_DIR = original_dir


def test_video_selection_skips_watermarked_play_addr_for_list_items():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    Config.DOWNLOAD_QUALITY = "auto"
    try:
        post = {
            "aweme_id": "1234567890123456789",
            "desc": "liked video",
            "video": {
                "play_addr": {"url_list": ["https://example.com/aweme/v1/playwm/?watermark=1"]},
                "download_addr": {"url_list": ["https://example.com/clean.mp4"]},
                "duration": 1000,
            },
            "statistics": {},
            "author": {},
        }

        result = manager._build_collection_video_item(post)

        assert result["media_urls"] == [{"type": "video", "url": "https://example.com/clean.mp4"}]
        assert result["video"]["play_addr"] == "https://example.com/clean.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_video_selection_skips_dash_video_only_candidates():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    Config.DOWNLOAD_QUALITY = "4k"
    try:
        video_data = {
            "play_addr": {"url_list": ["https://example.com/progressive.mp4"]},
            "bit_rate": [
                {
                    "data_size": 900,
                    "gear_name": "adapt_4k",
                    "play_addr": {"url_list": ["https://example.com/media-video-avc1"]},
                    "play_addr_h264": {"url_list": ["https://example.com/media_video_h264"]},
                }
            ],
        }

        assert _is_dash_video_only_url("https://example.com/media-video-avc1")
        assert manager._select_video_url(video_data) == "https://example.com/progressive.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_video_selection_honors_smallest_quality_for_list_items():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    Config.DOWNLOAD_QUALITY = "smallest"
    try:
        video_data = {
            "play_addr": {"url_list": ["https://example.com/default.mp4"]},
            "play_addr_lowbr": {"url_list": ["https://example.com/low.mp4"]},
            "bit_rate": [
                {
                    "data_size": 500,
                    "play_addr": {"url_list": ["https://example.com/high.mp4"]},
                    "play_addr_h264": {"url_list": ["https://example.com/high-h264.mp4"]},
                }
            ],
        }

        assert manager._select_video_url(video_data) == "https://example.com/low.mp4"
        assert manager._build_video_media_urls(video_data) == [
            {"type": "video", "url": "https://example.com/low.mp4"}
        ]
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_video_selection_honors_target_resolution_quality():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    video_data = {
        "play_addr": {"url_list": ["https://example.com/default.mp4"]},
        "height": 1080,
        "play_addr_lowbr": {"url_list": ["https://example.com/low.mp4"]},
        "bit_rate": [
            {
                "data_size": 100,
                "bit_rate": 100,
                "height": 480,
                "play_addr": {"url_list": ["https://example.com/p480.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/p480-h264.mp4"]},
            },
            {
                "data_size": 300,
                "bit_rate": 300,
                "height": 720,
                "play_addr": {"url_list": ["https://example.com/p720.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/p720-h264.mp4"]},
            },
            {
                "data_size": 500,
                "bit_rate": 500,
                "gear_name": "normal_1080_0",
                "height": 1920,
                "play_addr": {"url_list": ["https://example.com/p1080.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/p1080-h264.mp4"]},
            },
            {
                "data_size": 800,
                "bit_rate": 800,
                "gear_name": "normal_1080_1",
                "height": 1920,
                "is_h265": True,
                "play_addr": {"url_list": ["https://example.com/p1080-h265.mp4"]},
            },
            {
                "data_size": 700,
                "bit_rate": 700,
                "gear_name": "adapt_2k_1440p",
                "play_addr": {"url_list": ["https://example.com/p1440.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/p1440-h264.mp4"]},
            },
            {
                "data_size": 900,
                "bit_rate": 900,
                "gear_name": "adapt_4k",
                "play_addr": {"url_list": ["https://example.com/p2160.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/p2160-h264.mp4"]},
            },
        ],
    }

    try:
        Config.DOWNLOAD_QUALITY = "480p"
        assert manager._select_video_url(video_data) == "https://example.com/p480-h264.mp4"

        Config.DOWNLOAD_QUALITY = "1080p"
        assert manager._select_video_url(video_data) == "https://example.com/p1080-h264.mp4"

        Config.DOWNLOAD_QUALITY = "2k"
        assert manager._select_video_url(video_data) == "https://example.com/p1440-h264.mp4"

        Config.DOWNLOAD_QUALITY = "2160p"
        assert manager._select_video_url(video_data) == "https://example.com/p2160-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_video_selection_treats_target_resolution_as_maximum_height():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    video_data = {
        "play_addr": {"url_list": ["https://example.com/default.mp4"]},
        "bit_rate": [
            {
                "data_size": 100,
                "bit_rate": 100,
                "height": 480,
                "play_addr": {"url_list": ["https://example.com/sparse-480.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/sparse-480-h264.mp4"]},
            },
            {
                "data_size": 500,
                "bit_rate": 500,
                "gear_name": "normal_1080_0",
                "height": 1920,
                "play_addr": {"url_list": ["https://example.com/sparse-1080.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/sparse-1080-h264.mp4"]},
            },
        ],
    }

    try:
        Config.DOWNLOAD_QUALITY = "4k"
        assert manager._select_video_url(video_data) == "https://example.com/sparse-1080-h264.mp4"

        Config.DOWNLOAD_QUALITY = "1080p"
        assert manager._select_video_url(video_data) == "https://example.com/sparse-1080-h264.mp4"

        Config.DOWNLOAD_QUALITY = "720p"
        assert manager._select_video_url(video_data) == "https://example.com/sparse-480-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_video_candidate_merge_preserves_payload_quality_when_detail_is_lower():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    detail_video = {
        "play_addr": {"url_list": ["https://example.com/detail-default.mp4"]},
        "bit_rate": [
            {
                "data_size": 300,
                "bit_rate": 300,
                "gear_name": "normal_720_0",
                "height": 720,
                "play_addr": {"url_list": ["https://example.com/detail-720.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/detail-720-h264.mp4"]},
            },
        ],
    }
    payload_video = {
        "play_addr": {"url_list": ["https://example.com/payload-default.mp4"]},
        "bit_rate": [
            {
                "data_size": 500,
                "bit_rate": 500,
                "gear_name": "normal_1080_0",
                "height": 1080,
                "play_addr": {"url_list": ["https://example.com/payload-1080.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/payload-1080-h264.mp4"]},
            },
        ],
    }

    try:
        Config.DOWNLOAD_QUALITY = "4k"
        merged = manager.merge_video_download_candidates(detail_video, payload_video)

        assert manager._available_video_quality_height(merged) == 1080
        assert manager._video_quality_candidate_count(merged) == 4
        assert manager._select_video_url(merged) == "https://example.com/payload-1080-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_target_quality_prefers_explicit_bitrate_quality_over_top_level_url():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY

    def video_data(include_1080=False):
        bit_rates = [
            {
                "data_size": 100,
                "bit_rate": 100,
                "gear_name": "normal_540_0",
                "height": 580,
                "play_addr": {"url_list": ["https://example.com/toplow-540.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/toplow-540-h264.mp4"]},
            },
            {
                "data_size": 300,
                "bit_rate": 300,
                "gear_name": "normal_720_0",
                "height": 580,
                "play_addr": {"url_list": ["https://example.com/toplow-720.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/toplow-720-h264.mp4"]},
            },
        ]
        if include_1080:
            bit_rates.append({
                "data_size": 500,
                "bit_rate": 500,
                "gear_name": "normal_1080_0",
                "height": 580,
                "play_addr": {"url_list": ["https://example.com/toplow-1080.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/toplow-1080-h264.mp4"]},
            })
        return {
            "play_addr": {"url_list": ["https://example.com/toplow-default.mp4"]},
            "height": 580,
            "play_addr_h264": {"url_list": ["https://example.com/toplow-top-h264.mp4"]},
            "bit_rate": bit_rates,
        }

    try:
        Config.DOWNLOAD_QUALITY = "4k"
        assert manager._select_video_url(video_data(False)) == "https://example.com/toplow-720-h264.mp4"
        assert manager._select_video_url(video_data(True)) == "https://example.com/toplow-1080-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_target_quality_uses_short_side_for_portrait_2k_candidates():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    video_data = {
        "play_addr": {"url_list": ["https://example.com/default.mp4"]},
        "bit_rate": [
            {
                "data_size": 300,
                "bit_rate": 300,
                "width": 720,
                "height": 1280,
                "play_addr": {"url_list": ["https://example.com/portrait-720.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/portrait-720-h264.mp4"]},
            },
            {
                "data_size": 700,
                "bit_rate": 700,
                "width": 1440,
                "height": 2560,
                "play_addr": {"url_list": ["https://example.com/portrait-2k.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/portrait-2k-h264.mp4"]},
            },
        ],
    }

    try:
        Config.DOWNLOAD_QUALITY = "4k"
        assert manager._select_video_url(video_data) == "https://example.com/portrait-2k-h264.mp4"

        Config.DOWNLOAD_QUALITY = "1080p"
        assert manager._select_video_url(video_data) == "https://example.com/portrait-720-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_target_quality_uses_short_side_for_top_level_portrait_candidate():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    video_data = {
        "width": 1440,
        "height": 2560,
        "play_addr": {"url_list": ["https://example.com/top-portrait-2k.mp4"]},
        "play_addr_h264": {"url_list": ["https://example.com/top-portrait-2k-h264.mp4"]},
        "play_addr_lowbr": {"url_list": ["https://example.com/top-portrait-low.mp4"]},
    }

    try:
        Config.DOWNLOAD_QUALITY = "4k"
        assert manager._select_video_url(video_data) == "https://example.com/top-portrait-2k-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality


def test_target_quality_keeps_portrait_1080_candidate_above_720():
    manager = _user_manager()
    previous_quality = Config.DOWNLOAD_QUALITY
    video_data = {
        "play_addr": {"url_list": ["https://example.com/default.mp4"]},
        "bit_rate": [
            {
                "data_size": 300,
                "bit_rate": 300,
                "width": 404,
                "height": 720,
                "play_addr": {"url_list": ["https://example.com/narrow-720.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/narrow-720-h264.mp4"]},
            },
            {
                "data_size": 500,
                "bit_rate": 500,
                "width": 608,
                "height": 1080,
                "play_addr": {"url_list": ["https://example.com/narrow-1080.mp4"]},
                "play_addr_h264": {"url_list": ["https://example.com/narrow-1080-h264.mp4"]},
            },
        ],
    }

    try:
        Config.DOWNLOAD_QUALITY = "4k"
        assert manager._select_video_url(video_data) == "https://example.com/narrow-1080-h264.mp4"
    finally:
        Config.DOWNLOAD_QUALITY = previous_quality
