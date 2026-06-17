import os
import json
import getpass

import sys

# 判断是否被 PyInstaller 打包
IS_FROZEN = getattr(sys, 'frozen', False)
if IS_FROZEN:
    # 执行文件所在目录（供存储配置、下载）
    APP_EXEC_DIR = os.path.dirname(sys.executable)
    # 资源内嵌目录（供读取静态文件）
    APP_RESOURCE_DIR = sys._MEIPASS
else:
    # 源码运行模式
    APP_EXEC_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    APP_RESOURCE_DIR = APP_EXEC_DIR

def get_resource_path(relative_path):
    """获取程序静态资源或内置代码所在绝对路径"""
    return os.path.join(APP_RESOURCE_DIR, relative_path)

class Config:
    """配置类"""
    # 配置文件路径在执行文件旁边
    CONFIG_FILE = os.path.join(APP_EXEC_DIR, "config.json")
    
    # Cookie设置
    COOKIE = ""
    RELATION_SIGNER = None
    CURRENT_USER_PROFILE = None
    APP_VERSION = (os.environ.get("APP_VERSION") or os.environ.get("GITHUB_REF_NAME") or "1.0.25").lstrip("v")

    # 文件保存路径默认在执行文件旁边
    BASE_DIR = os.path.join(APP_EXEC_DIR, "douyin_download")
    DOWNLOAD_DIR = BASE_DIR
    HISTORY_DIRS = []
    DOWNLOAD_QUALITY = "auto"
    MAX_CONCURRENT = 3
    
    # 请求参数
    HOST = 'https://www.douyin.com'
    COMMON_PARAMS = {
        'device_platform': 'webapp',
        'aid': '6383',
        'channel': 'channel_pc_web',
        'pc_client_type': '1',
        'version_code': '190500',
        'version_name': '19.5.0',
        'cookie_enabled': 'true',
        'screen_width': '1680',
        'screen_height': '1050',
        'browser_language': 'zh-CN',
        'browser_platform': 'Win32',
        'browser_name': 'Chrome',
        'browser_version': '126.0.0.0',
        'browser_online': 'true',
        'engine_name': 'Blink',
        'engine_version': '126.0.0.0',
        'os_name': 'Windows',
        'os_version': '10',
        'cpu_core_num': '8',
        'device_memory': '8',
        'platform': 'PC',
        'downlink': '10',
        'effective_type': '4g',
        'round_trip_time': '50',
    }
    
    # 请求头
    COMMON_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "sec-ch-ua-platform": "Windows",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        "referer": "https://www.douyin.com/?recommend=1",
        "priority": "u=1, i",
        "pragma": "no-cache",
        "cache-control": "no-cache",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "accept": "application/json, text/plain, */*",
        "dnt": "1",
    }
    
    # 下载设置
    CHUNK_SIZE = 8192  # 下载块大小
    
    
    # 文件命名设置
    MAX_FILENAME_LENGTH = 180  # 文件名最大字符数
    MAX_FILENAME_BYTES = 230  # 预留扩展名和自动去重后缀空间，避免超过常见文件系统限制
    FILENAME_TEMPLATE = "{title}"
    FOLDER_NAME_TEMPLATE = "{author}"
    AUTO_CREATE_FOLDER = True
    IM_FRIEND_SEC_USER_IDS = []
    IM_FRIEND_INCLUDE_ALL_USERS = False
    IM_FRIEND_REFRESH_INTERVAL_SECONDS = 30
    
    @classmethod
    def load_config(cls):
        """从配置文件或环境变量加载配置"""
        cls.HISTORY_DIRS = []
        cls.DOWNLOAD_DIR = cls.BASE_DIR
        loaded_from_file = False

        # 先读取配置文件，再用环境变量覆盖，方便无界面部署和临时调试。
        if os.path.exists(cls.CONFIG_FILE):
            try:
                with open(cls.CONFIG_FILE, 'r', encoding='utf-8') as f:
                    config_data = json.load(f)
                    cls.COOKIE = config_data.get("cookie", cls.COOKIE).replace('\n', '').replace('\r', '').strip()
                    relation_signer = config_data.get("relation_signer")
                    cls.RELATION_SIGNER = relation_signer if isinstance(relation_signer, dict) else None
                    current_user_profile = config_data.get("current_user_profile")
                    cls.CURRENT_USER_PROFILE = current_user_profile if isinstance(current_user_profile, dict) else None
                    cls.BASE_DIR = config_data.get("base_dir", cls.BASE_DIR)
                    cls.DOWNLOAD_DIR = cls.BASE_DIR
                    cls.HISTORY_DIRS = cls.normalize_history_dirs(config_data.get("history_dirs", []))
                    cls.DOWNLOAD_QUALITY = str(config_data.get("download_quality", cls.DOWNLOAD_QUALITY) or "auto")
                    cls.FILENAME_TEMPLATE = cls.normalize_filename_template(
                        config_data.get("filename_template", cls.FILENAME_TEMPLATE),
                        cls.FILENAME_TEMPLATE,
                    )
                    cls.FOLDER_NAME_TEMPLATE = cls.normalize_filename_template(
                        config_data.get("folder_name_template", cls.FOLDER_NAME_TEMPLATE),
                        cls.FOLDER_NAME_TEMPLATE,
                    )
                    cls.AUTO_CREATE_FOLDER = bool(config_data.get("auto_create_folder", cls.AUTO_CREATE_FOLDER))
                    cls.IM_FRIEND_SEC_USER_IDS = cls.normalize_sec_user_ids(
                        config_data.get("im_friend_sec_user_ids", cls.IM_FRIEND_SEC_USER_IDS)
                    )
                    cls.IM_FRIEND_INCLUDE_ALL_USERS = bool(
                        config_data.get("im_friend_include_all_users", cls.IM_FRIEND_INCLUDE_ALL_USERS)
                    )
                    try:
                        cls.IM_FRIEND_REFRESH_INTERVAL_SECONDS = max(
                            1,
                            min(
                                3600,
                                int(
                                    config_data.get(
                                        "im_friend_refresh_interval_seconds",
                                        cls.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
                                    )
                                    or 30
                                ),
                            ),
                        )
                    except Exception:
                        cls.IM_FRIEND_REFRESH_INTERVAL_SECONDS = 30
                    try:
                        cls.MAX_CONCURRENT = max(1, min(10, int(config_data.get("max_concurrent", cls.MAX_CONCURRENT) or 3)))
                    except Exception:
                        cls.MAX_CONCURRENT = 3
                    legacy_dir = os.path.join(cls.BASE_DIR, "douyin_download")
                    if os.path.isdir(legacy_dir) and os.path.abspath(legacy_dir).lower() != os.path.abspath(cls.DOWNLOAD_DIR).lower():
                        cls.HISTORY_DIRS = cls.normalize_history_dirs([*cls.HISTORY_DIRS, legacy_dir])
                    print("\033[92m配置已从配置文件加载\033[0m")
                    loaded_from_file = True
            except Exception as e:
                print(f"\033[91m加载配置文件失败: {str(e)}\033[0m")

        cls.apply_env_overrides()
        return loaded_from_file

    @classmethod
    def apply_env_overrides(cls):
        """使用环境变量覆盖配置文件值。"""
        env_cookie = os.environ.get("DOUYIN_COOKIE")
        env_base_dir = os.environ.get("DOUYIN_BASE_DIR")
        env_quality = os.environ.get("DOUYIN_DOWNLOAD_QUALITY")
        env_max_concurrent = os.environ.get("DOUYIN_MAX_CONCURRENT")
        env_relation_signer = os.environ.get("DOUYIN_RELATION_SIGNER")

        if env_cookie is not None:
            cls.COOKIE = env_cookie.replace('\n', '').replace('\r', '').strip()
        if env_base_dir:
            cls.BASE_DIR = env_base_dir
            cls.DOWNLOAD_DIR = cls.BASE_DIR
        if env_quality:
            cls.DOWNLOAD_QUALITY = str(env_quality or "auto")
        if env_max_concurrent:
            try:
                cls.MAX_CONCURRENT = max(1, min(10, int(env_max_concurrent)))
            except Exception:
                pass
        if env_relation_signer:
            try:
                signer = json.loads(env_relation_signer)
                if isinstance(signer, dict):
                    cls.RELATION_SIGNER = signer
            except Exception:
                pass
    
    @classmethod
    def normalize_history_dirs(cls, history_dirs):
        """归一化历史下载目录列表。"""
        normalized = []
        seen = set()

        if not isinstance(history_dirs, list):
            return normalized

        for item in history_dirs:
            if not item:
                continue
            try:
                path = os.path.abspath(str(item))
            except Exception:
                continue

            key = path.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(path)

        return normalized

    @classmethod
    def normalize_filename_template(cls, template, default):
        """归一化用户可配置的命名模板。"""
        value = str(template or '').strip()
        if not value:
            return default
        return value[:160]

    @classmethod
    def normalize_sec_user_ids(cls, values):
        """归一化 IM 好友 sec_user_id 缓存。"""
        if not isinstance(values, list):
            return []
        normalized = []
        seen = set()
        for item in values:
            value = str(item or '').strip()
            if not value or not value.startswith('MS4w'):
                continue
            if value in seen:
                continue
            seen.add(value)
            normalized.append(value)
        return normalized

    @classmethod
    def save_config(
        cls,
        cookie,
        base_dir,
        history_dirs=None,
        download_quality=None,
        max_concurrent=None,
        filename_template=None,
        folder_name_template=None,
        auto_create_folder=None,
        relation_signer=None,
        current_user_profile=None,
        im_friend_sec_user_ids=None,
        im_friend_include_all_users=None,
        im_friend_refresh_interval_seconds=None,
    ):
        """保存配置到配置文件"""
        resolved_quality = str(download_quality or cls.DOWNLOAD_QUALITY or "auto")
        try:
            resolved_max_concurrent = max(1, min(10, int(max_concurrent if max_concurrent is not None else cls.MAX_CONCURRENT)))
        except Exception:
            resolved_max_concurrent = cls.MAX_CONCURRENT
        resolved_filename_template = cls.normalize_filename_template(
            filename_template if filename_template is not None else cls.FILENAME_TEMPLATE,
            cls.FILENAME_TEMPLATE,
        )
        resolved_folder_name_template = cls.normalize_filename_template(
            folder_name_template if folder_name_template is not None else cls.FOLDER_NAME_TEMPLATE,
            cls.FOLDER_NAME_TEMPLATE,
        )
        resolved_auto_create_folder = cls.AUTO_CREATE_FOLDER if auto_create_folder is None else bool(auto_create_folder)
        resolved_im_friend_sec_user_ids = cls.normalize_sec_user_ids(
            im_friend_sec_user_ids if im_friend_sec_user_ids is not None else cls.IM_FRIEND_SEC_USER_IDS
        )
        resolved_im_friend_include_all_users = (
            cls.IM_FRIEND_INCLUDE_ALL_USERS
            if im_friend_include_all_users is None
            else bool(im_friend_include_all_users)
        )
        try:
            resolved_im_friend_refresh_interval_seconds = max(
                1,
                min(
                    3600,
                    int(
                        im_friend_refresh_interval_seconds
                        if im_friend_refresh_interval_seconds is not None
                        else cls.IM_FRIEND_REFRESH_INTERVAL_SECONDS
                    ),
                ),
            )
        except Exception:
            resolved_im_friend_refresh_interval_seconds = 30

        config_data = {
            "cookie": cookie,
            "relation_signer": relation_signer if relation_signer is not None else cls.RELATION_SIGNER,
            "current_user_profile": current_user_profile if current_user_profile is not None else cls.CURRENT_USER_PROFILE,
            "base_dir": base_dir,
            "history_dirs": cls.normalize_history_dirs(history_dirs if history_dirs is not None else cls.HISTORY_DIRS),
            "download_quality": resolved_quality,
            "max_concurrent": resolved_max_concurrent,
            "filename_template": resolved_filename_template,
            "folder_name_template": resolved_folder_name_template,
            "auto_create_folder": resolved_auto_create_folder,
            "im_friend_sec_user_ids": resolved_im_friend_sec_user_ids,
            "im_friend_include_all_users": resolved_im_friend_include_all_users,
            "im_friend_refresh_interval_seconds": resolved_im_friend_refresh_interval_seconds,
        }
        try:
            config_dir = os.path.dirname(cls.CONFIG_FILE)
            os.makedirs(config_dir, exist_ok=True)
            temp_file = f"{cls.CONFIG_FILE}.tmp"
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, ensure_ascii=False, indent=2)
                f.write('\n')
            os.replace(temp_file, cls.CONFIG_FILE)
            print("\033[92m配置已保存到配置文件\033[0m")
            return True
        except Exception as e:
            try:
                os.remove(f"{cls.CONFIG_FILE}.tmp")
            except Exception:
                pass
            print(f"\033[91m保存配置文件失败: {str(e)}\033[0m")
            return False
    
    
    @classmethod
    def init(cls):
        """初始化配置"""
        cls.load_config()

        # 确保下载目录存在
        os.makedirs(cls.DOWNLOAD_DIR, exist_ok=True)

        if not cls.COOKIE:
            print("\033[93m警告: 未设置抖音cookie，部分功能将受限\033[0m")

        return True
