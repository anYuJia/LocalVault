import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.config.config import Config
from src.downloader.downloader import build_download_title


def check_download_title_can_omit_aweme_id_suffix():
    aweme_id = "7380011223344556677"
    title = build_download_title("这是 一个 完整 标题 第二段 文案", aweme_id, template="{title}")

    assert title == "这是 一个 完整 标题 第二段 文案"


def check_long_download_title_preserves_aweme_id_suffix_when_requested():
    aweme_id = "7380011223344556677"
    title = build_download_title("很长标题" * 80, aweme_id, template="{title}_{aweme_id}")

    assert title.endswith(aweme_id)
    assert len(title.encode("utf-8")) <= Config.MAX_FILENAME_BYTES


def check_long_download_title_keeps_more_safe_text():
    aweme_id = "7380011223344556677"
    desc = "abcdefghijklmnopqrstuvwxyz" * 8
    title = build_download_title(desc, aweme_id, template="{title}_{aweme_id}")

    assert title.startswith("abcdefghijklmnopqrstuvwxyz" * 6)
    assert title.endswith(aweme_id)
    assert len(title.encode("utf-8")) <= Config.MAX_FILENAME_BYTES


def check_download_title_uses_work_create_time_for_date_tokens():
    aweme_id = "7380011223344556677"
    create_time = 1704067205
    expected_prefix = time.strftime("%Y%m%d_%Y%m%d_%H%M%S", time.localtime(create_time))

    title = build_download_title(
        "跨年作品",
        aweme_id,
        template="{date}_{time}_{title}_{aweme_id}",
        create_time=create_time,
    )

    assert title == f"{expected_prefix}_跨年作品_{aweme_id}"


def check_download_title_leaves_date_tokens_empty_without_create_time():
    title = build_download_title(
        "无发布时间作品",
        "7380011223344556677",
        template="{date}_{time}_{title}_{aweme_id}",
        create_time=0,
    )

    assert title == "无发布时间作品_7380011223344556677"


def check_download_title_keeps_legacy_positional_template_argument():
    aweme_id = "7380011223344556677"
    title = build_download_title("旧调用", aweme_id, "", "", "{title}_{aweme_id}")

    assert title == f"旧调用_{aweme_id}"


if __name__ == "__main__":
    check_download_title_can_omit_aweme_id_suffix()
    check_long_download_title_preserves_aweme_id_suffix_when_requested()
    check_long_download_title_keeps_more_safe_text()
    check_download_title_uses_work_create_time_for_date_tokens()
    check_download_title_leaves_date_tokens_empty_without_create_time()
    check_download_title_keeps_legacy_positional_template_argument()
