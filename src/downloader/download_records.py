"""下载记录管理逻辑拆分模块。

将 DouyinDownloader 中下载记录相关的方法抽取到独立模块，
降低主文件复杂度。通过 DownloadRecords 类持有 DouyinDownloader 实例引用。
"""
import json
import logging
import os
import re
import threading

from src.config.config import Config

logger = logging.getLogger('downloader.records')


class DownloadRecords:
    """下载记录管理，封装记录的加载、保存、查询等操作。"""

    def __init__(self, downloader):
        """
        Args:
            downloader: DouyinDownloader 实例，用于共享配置和状态。
        """
        self._dl = downloader
        self._record_lock = threading.Lock()
        self._download_record_cache: dict[str, set] = {}
        self._all_download_records_cache: set = set()
        self._downloaded_file_ids_cache: set = set()
        self._all_download_records_loaded = False
        self._all_download_records_roots = ()

    # ---------- 基础属性委托 ----------

    @property
    def download_dir(self) -> str:
        return self._dl.download_dir

    @download_dir.setter
    def download_dir(self, value: str):
        self._dl.download_dir = value

    @property
    def debug_mode(self) -> bool:
        return self._dl.debug_mode

    def _sanitize_path_segment(self, name: str, default: str = '未知作者') -> str:
        return self._dl._sanitize_path_segment(name, default)

    # ---------- 缓存管理 ----------

    def clear_cache(self):
        """清除所有下载记录缓存。"""
        self._download_record_cache.clear()
        self._all_download_records_cache.clear()
        self._downloaded_file_ids_cache.clear()
        self._all_download_records_loaded = False
        self._all_download_records_roots = ()

    def sync_download_dir(self):
        """同步下载目录配置变更。"""
        current_download_dir = os.path.abspath(str(Config.DOWNLOAD_DIR))
        if os.path.abspath(str(self.download_dir)) == current_download_dir:
            return
        with self._record_lock:
            if os.path.abspath(str(self.download_dir)) != current_download_dir:
                self.download_dir = current_download_dir
                self.clear_cache()
                os.makedirs(self.download_dir, exist_ok=True)

    # ---------- 文件检查工具 ----------

    @staticmethod
    def _extract_downloaded_aweme_id(filename: str) -> str:
        """从文件名中提取 aweme_id。"""
        stem = os.path.splitext(str(filename or ''))[0]
        match = re.search(r'_(\d{10,25})(?:_\d{2})?$', stem)
        return match.group(1) if match else ''

    @staticmethod
    def _is_complete_download_file(dirpath: str, filename: str) -> bool:
        """检查文件是否是完整的下载文件（非临时文件）。"""
        if not filename or filename.startswith('.'):
            return False
        lower_name = filename.lower()
        if lower_name.endswith(('.tmp', '.part', '.download', '.crdownload')):
            return False
        if filename == "download_record.json":
            return False
        try:
            return os.path.getsize(os.path.join(dirpath, filename)) > 4096
        except OSError:
            return False

    # ---------- 记录路径 ----------

    def _get_record_path(self, user_dir: str) -> str:
        """获取用户下载记录文件路径。"""
        self.sync_download_dir()
        sanitized_user_dir = self._sanitize_path_segment(user_dir, '未知作者') if str(user_dir or '').strip() else ''
        user_path = os.path.join(self.download_dir, sanitized_user_dir)
        if self.debug_mode:
            print(f"\033[93m[Downloader] 创建用户目录: {user_path}\033[0m")
        os.makedirs(user_path, exist_ok=True)
        record_path = os.path.join(user_path, "download_record.json")
        if self.debug_mode:
            print(f"\033[93m[Downloader] 下载记录文件路径: {record_path}\033[0m")
        return record_path

    def _record_roots(self) -> list[str]:
        """获取所有下载记录根目录。"""
        self.sync_download_dir()
        roots = []
        seen = set()
        for raw_root in [self.download_dir, *getattr(Config, 'HISTORY_DIRS', [])]:
            if not raw_root:
                continue
            root = os.path.abspath(str(raw_root))
            key = root.lower()
            if key in seen:
                continue
            seen.add(key)
            roots.append(root)
        return roots

    # ---------- 记录加载 ----------

    def _load_download_record(self, user_dir: str) -> set:
        """加载用户下载记录。"""
        record_path = self._get_record_path(user_dir)
        try:
            with self._record_lock:
                if record_path in self._download_record_cache:
                    return set(self._download_record_cache[record_path])

                if os.path.exists(record_path):
                    if self.debug_mode:
                        print(f"\033[93m[Downloader] 加载下载记录: {record_path}\033[0m")
                    with open(record_path, 'r', encoding='utf-8') as f:
                        raw_records = json.load(f)
                        records = set(raw_records if isinstance(raw_records, list) else [])
                        self._download_record_cache[record_path] = set(records)
                        if self.debug_mode:
                            print(f"\033[93m[Downloader] 已下载记录数: {len(records)}\033[0m")
                        return records
                elif self.debug_mode:
                    print(f"\033[93m[Downloader] 下载记录文件不存在，创建新记录\033[0m")
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 加载下载记录失败: {str(e)}\033[0m")
            else:
                print(f"\033[91m加载下载记录失败\033[0m")
        with self._record_lock:
            self._download_record_cache[record_path] = set()
        return set()

    def _load_all_download_records(self) -> set:
        """加载所有下载目录中的作品记录，避免命名规则变化后重复下载。"""
        records = set()
        file_ids = set()
        try:
            with self._record_lock:
                roots = tuple(self._record_roots())
                if self._all_download_records_loaded and self._all_download_records_roots == roots:
                    return set(self._all_download_records_cache)

                for root in roots:
                    if not os.path.isdir(root):
                        continue
                    for dirpath, _, filenames in os.walk(root):
                        for filename in filenames:
                            if filename == "download_record.json":
                                record_path = os.path.join(dirpath, filename)
                                try:
                                    with open(record_path, 'r', encoding='utf-8') as f:
                                        raw_records = json.load(f)
                                    if isinstance(raw_records, list):
                                        record_set = {str(item) for item in raw_records if item}
                                        records.update(record_set)
                                        self._download_record_cache[record_path] = record_set
                                except Exception as e:
                                    if self.debug_mode:
                                        print(f"\033[91m[Downloader] 读取下载记录失败 {record_path}: {str(e)}\033[0m")
                            elif self._is_complete_download_file(dirpath, filename):
                                aweme_id = self._extract_downloaded_aweme_id(filename)
                                if aweme_id:
                                    file_ids.add(aweme_id)
                self._downloaded_file_ids_cache = records & file_ids
                self._all_download_records_cache = set(self._downloaded_file_ids_cache)
                self._all_download_records_loaded = True
                self._all_download_records_roots = roots
        except Exception as e:
            if self.debug_mode:
                print(f"\033[91m[Downloader] 加载全局下载记录失败: {str(e)}\033[0m")
        return records

    # ---------- 记录查询 ----------

    def _downloaded_file_exists(self, aweme_id: str) -> bool:
        """检查文件系统中是否存在该 aweme_id 的下载文件。"""
        normalized_aweme_id = str(aweme_id or '').strip()
        if not normalized_aweme_id:
            return False

        if self._all_download_records_loaded:
            return normalized_aweme_id in self._downloaded_file_ids_cache

        for root in self._record_roots():
            if not os.path.isdir(root):
                continue
            for dirpath, _, filenames in os.walk(root):
                for filename in filenames:
                    if not self._is_complete_download_file(dirpath, filename):
                        continue
                    if self._extract_downloaded_aweme_id(filename) == normalized_aweme_id:
                        return True
        return False

    def _is_aweme_downloaded(self, aweme_id: str, user_dir: str = '') -> bool:
        """检查作品是否已下载（记录中存在且文件存在）。"""
        normalized_aweme_id = str(aweme_id or '').strip()
        if not normalized_aweme_id:
            return False
        all_records = self._load_all_download_records()
        recorded = (
            normalized_aweme_id in self._load_download_record(user_dir)
            or normalized_aweme_id in all_records
        )
        return recorded and self._downloaded_file_exists(normalized_aweme_id)

    # ---------- 记录保存 ----------

    def _save_download_record(self, user_dir: str, aweme_id: str):
        """保存下载记录。"""
        record_path = self._get_record_path(user_dir)
        try:
            with self._record_lock:
                downloaded = set()
                if os.path.exists(record_path):
                    if record_path in self._download_record_cache:
                        downloaded = set(self._download_record_cache[record_path])
                    else:
                        with open(record_path, 'r', encoding='utf-8') as f:
                            raw_records = json.load(f)
                            downloaded = set(raw_records if isinstance(raw_records, list) else [])

                downloaded.add(aweme_id)

                if self.debug_mode:
                    print(f"\033[93m[Downloader] 添加下载记录: {aweme_id}\033[0m")
                    print(f"\033[93m[Downloader] 当前记录总数: {len(downloaded)}\033[0m")

                temp_path = f"{record_path}.tmp"
                with open(temp_path, 'w', encoding='utf-8') as f:
                    json.dump(sorted(downloaded), f, ensure_ascii=False)
                    f.write('\n')
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp_path, record_path)
                try:
                    dir_fd = os.open(os.path.dirname(record_path), os.O_RDONLY)
                    try:
                        os.fsync(dir_fd)
                    finally:
                        os.close(dir_fd)
                except Exception:
                    pass
                self._download_record_cache[record_path] = set(downloaded)
                self._all_download_records_cache.add(str(aweme_id))
                self._downloaded_file_ids_cache.add(str(aweme_id))

            if self.debug_mode:
                print(f"\033[92m[Downloader] 保存下载记录成功: {record_path}\033[0m")
        except Exception as e:
            try:
                os.remove(f"{record_path}.tmp")
            except Exception:
                pass
            if self.debug_mode:
                print(f"\033[91m[Downloader] 保存下载记录失败: {str(e)}\033[0m")
            else:
                print(f"\033[91m保存下载记录失败：{str(e)}\033[0m")
