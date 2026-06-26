import os
import json
import getpass
import sys
import platform

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

def get_user_data_dir():
    """获取用户配置数据持久化存储目录"""
    if not IS_FROZEN:
        return APP_EXEC_DIR
    
    app_name = "better-douyin"
    system_name = platform.system()
    if system_name == 'Darwin':
        return os.path.expanduser(f"~/Library/Application Support/{app_name}")
    elif system_name == 'Windows':
        exe_path = sys.executable.lower()
        is_installed = ("program files" in exe_path) or ("appdata\\local\\programs" in exe_path)
        if is_installed:
            appdata = os.environ.get("APPDATA")
            if appdata:
                return os.path.join(appdata, app_name)
        return APP_EXEC_DIR
    else:
        exe_path = sys.executable.lower()
        is_installed = exe_path.startswith("/usr") or exe_path.startswith("/opt") or exe_path.startswith("/var")
        if is_installed:
            config_home = os.environ.get("XDG_CONFIG_HOME")
            if config_home:
                return os.path.join(config_home, app_name)
            return os.path.expanduser(f"~/.config/{app_name}")
        return APP_EXEC_DIR

def get_default_download_dir(user_data_dir):
    """根据运行模式获取默认下载目录"""
    if not IS_FROZEN:
        return os.path.join(APP_EXEC_DIR, "douyin_download")
        
    system_name = platform.system()
    if system_name == 'Darwin':
        return os.path.expanduser("~/Downloads/better-douyin")
    
    if user_data_dir == APP_EXEC_DIR:
        # 便携模式
        return os.path.join(APP_EXEC_DIR, "douyin_download")
    else:
        # 安装模式
        return os.path.expanduser("~/Downloads/better-douyin")

class Config:
    """配置类"""
    USER_DATA_DIR = get_user_data_dir()
    # 配置文件路径
    CONFIG_FILE = os.path.join(USER_DATA_DIR, "config.json")
    
    # Cookie设置
    COOKIE = ""
    RELATION_SIGNER = None
    CURRENT_USER_PROFILE = None
    ACCOUNTS = []
    CURRENT_SEC_UID = ""
    APP_VERSION = (os.environ.get("APP_VERSION") or os.environ.get("GITHUB_REF_NAME") or "1.0.29").lstrip("v")

    # 文件保存路径默认值
    BASE_DIR = get_default_download_dir(USER_DATA_DIR)
    DOWNLOAD_DIR = BASE_DIR
    HISTORY_DIRS = []
    DOWNLOAD_QUALITY = "auto"
    DOWNLOAD_QUALITY_VALUES = {"auto", "highest", "h264", "smallest", "480p", "720p", "1080p", "2k", "4k"}
    DOWNLOAD_QUALITY_ALIASES = {
        "p480": "480p",
        "p720": "720p",
        "p1080": "1080p",
        "p1440": "2k",
        "1440p": "2k",
        "p2160": "4k",
        "2160p": "4k",
    }
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
        # 1. 自动从旧的位置 (APP_EXEC_DIR) 迁移配置文件和状态文件
        old_config_file = os.path.join(APP_EXEC_DIR, "config.json")
        new_config_file = cls.CONFIG_FILE
        if old_config_file != new_config_file and os.path.exists(old_config_file) and not os.path.exists(new_config_file):
            try:
                config_dir = os.path.dirname(new_config_file)
                os.makedirs(config_dir, exist_ok=True)
                import shutil
                shutil.copy2(old_config_file, new_config_file)
                print(f"\033[92m已将旧配置文件从 {old_config_file} 迁移至 {new_config_file}\033[0m")
                
                # 迁移下载历史记录索引
                old_history = os.path.join(APP_EXEC_DIR, 'download_history_index.json')
                new_history = os.path.join(config_dir, 'download_history_index.json')
                if os.path.exists(old_history) and not os.path.exists(new_history):
                    shutil.copy2(old_history, new_history)
                
                # 迁移好友聊天状态缓存
                old_chat = os.path.join(APP_EXEC_DIR, 'friend_chat_state.json')
                new_chat = os.path.join(config_dir, 'friend_chat_state.json')
                if os.path.exists(old_chat) and not os.path.exists(new_chat):
                    shutil.copy2(old_chat, new_chat)
            except Exception as e:
                print(f"\033[91m自动迁移旧数据失败: {str(e)}\033[0m")

        cls.HISTORY_DIRS = []
        cls.DOWNLOAD_DIR = cls.BASE_DIR
        cls.ACCOUNTS = []
        cls.CURRENT_SEC_UID = ""
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
                    cls.ACCOUNTS = config_data.get("accounts", [])
                    cls.CURRENT_SEC_UID = config_data.get("current_sec_uid", "")
                    cls.BASE_DIR = config_data.get("base_dir", cls.BASE_DIR)
                    cls.DOWNLOAD_DIR = cls.BASE_DIR
                    cls.HISTORY_DIRS = cls.normalize_history_dirs(config_data.get("history_dirs", []))
                    cls.DOWNLOAD_QUALITY = cls.normalize_download_quality(
                        config_data.get("download_quality", cls.DOWNLOAD_QUALITY)
                    )
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

        # 检测并纠正安装模式/包下不安全的下载路径
        if IS_FROZEN and not cls.is_portable():
            abs_base_dir = os.path.abspath(cls.BASE_DIR)
            abs_base_dir_lower = abs_base_dir.lower()
            abs_exec_dir = os.path.abspath(APP_EXEC_DIR).lower()
            # 如果下载目录是执行目录或其子目录，或者在 macOS .app 包内
            if (abs_base_dir_lower == abs_exec_dir or 
                abs_base_dir_lower.startswith(abs_exec_dir + os.sep) or 
                (platform.system() == 'Darwin' and '.app/' in abs_base_dir_lower)):
                
                safe_default = os.path.expanduser("~/Downloads/better-douyin")
                cls.BASE_DIR = safe_default
                cls.DOWNLOAD_DIR = cls.BASE_DIR
                cls.save_config(
                    cookie=cls.COOKIE,
                    base_dir=cls.BASE_DIR,
                    history_dirs=cls.HISTORY_DIRS,
                    download_quality=cls.DOWNLOAD_QUALITY,
                    max_concurrent=cls.MAX_CONCURRENT,
                    filename_template=cls.FILENAME_TEMPLATE,
                    folder_name_template=cls.FOLDER_NAME_TEMPLATE,
                    auto_create_folder=cls.AUTO_CREATE_FOLDER,
                    relation_signer=cls.RELATION_SIGNER,
                    current_user_profile=cls.CURRENT_USER_PROFILE,
                    accounts=cls.ACCOUNTS,
                    current_sec_uid=cls.CURRENT_SEC_UID,
                    im_friend_sec_user_ids=cls.IM_FRIEND_SEC_USER_IDS,
                    im_friend_include_all_users=cls.IM_FRIEND_INCLUDE_ALL_USERS,
                    im_friend_refresh_interval_seconds=cls.IM_FRIEND_REFRESH_INTERVAL_SECONDS,
                )
                print(f"\033[93m检测到不安全的下载目录在安装包/程序包内，已自动重置为: {safe_default}\033[0m")

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
            cls.DOWNLOAD_QUALITY = cls.normalize_download_quality(env_quality)
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
    def normalize_download_quality(cls, quality):
        """归一化视频下载质量配置。"""
        normalized = str(quality or "auto").strip().lower()
        canonical = cls.DOWNLOAD_QUALITY_ALIASES.get(normalized, normalized)
        if canonical in cls.DOWNLOAD_QUALITY_VALUES:
            return canonical
        return "auto"

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
        accounts=None,
        current_sec_uid=None,
        im_friend_sec_user_ids=None,
        im_friend_include_all_users=None,
        im_friend_refresh_interval_seconds=None,
    ):
        """保存配置到配置文件"""
        resolved_quality = cls.normalize_download_quality(download_quality or cls.DOWNLOAD_QUALITY)
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
        resolved_accounts = accounts if accounts is not None else cls.ACCOUNTS
        resolved_current_sec_uid = current_sec_uid if current_sec_uid is not None else cls.CURRENT_SEC_UID
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
            "accounts": resolved_accounts,
            "current_sec_uid": resolved_current_sec_uid,
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

    @classmethod
    def is_portable(cls):
        """判断当前运行版本是否为便携版 (仅对 Windows/Linux 有意义，macOS 统一非便携)"""
        if not IS_FROZEN:
            return True
        system_name = platform.system()
        if system_name == 'Darwin':
            return False
        user_data_dir = get_user_data_dir()
        return user_data_dir == APP_EXEC_DIR
