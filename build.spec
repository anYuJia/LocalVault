# -*- mode: python ; coding: utf-8 -*-
import os
import sys

# 获取项目根目录，以便于寻址
project_root = os.path.abspath('.')
raw_app_version = os.environ.get('APP_VERSION') or os.environ.get('GITHUB_REF_NAME') or '1.0.24'
app_version = raw_app_version[1:] if raw_app_version.startswith('v') else raw_app_version
import webview as _pywebview
pywebview_hooks = os.path.join(_pywebview.__path__[0], 'pkg')

# 图标文件路径
if sys.platform == 'darwin':
    icon_path = os.path.join(project_root, 'icons/icon.icns')
elif sys.platform == 'win32':
    icon_path = os.path.join(project_root, 'icons/icon.ico')
else:
    icon_path = None

block_cipher = None

# 需要被一同打包进程序结构里的相关资源文件
datas = [
    (os.path.join(project_root, 'src/web/react_dist'), 'src/web/react_dist'),
    (os.path.join(project_root, 'lib/js/douyin.js'), 'lib/js'),
    # 如果有其他非 Python 资源，也应添加到这里
]

# 核心依赖项与可能被动态加载的模块
hiddenimports = [
    'engineio.async_drivers.gevent',
    'engineio.async_drivers.threading',
    'gevent',
    'geventwebsocket',
    'greenlet',
    'simple_websocket',
    'flask',
    'flask_socketio',
    'requests',
    'urllib3',
    'aiohttp',
    'multiprocessing',
    'uuid',
    'logging',
    'datetime',
    'json',
    're',
    'urllib.parse',
    'execjs',
    'src',
    'src.api',
    'src.config',
    'src.downloader',
    'src.user',
    'src.web',
    'src.web.web_app',
    'src.api.native_cookie_login',
    'webview',
    'webview.platforms',
    'webview.platforms.cocoa',
]

# Windows .NET bridge
if sys.platform == 'win32':
    hiddenimports.extend([
        'pythonnet',
        'clr',
        'clr_loader',
        'webview.platforms.winforms',
    ])
    datas.append((os.path.join(project_root, 'windows', 'better-douyin.exe.config'), '.'))

# 收集pythonnet运行时DLL（Windows）
# 放在根目录而不是_internal，解决pythonnet加载问题
binaries = []
if sys.platform == 'win32':
    try:
        import pythonnet
        import os
        pythonnet_path = os.path.dirname(pythonnet.__file__)
        runtime_dll = os.path.join(pythonnet_path, 'runtime', 'Python.Runtime.dll')
        if os.path.exists(runtime_dll):
            # 放在根目录（与exe同级）
            binaries.append((runtime_dll, '.'))
            print(f"[build.spec] Found Python.Runtime.dll at: {runtime_dll}")
        else:
            print(f"[build.spec] Warning: Python.Runtime.dll not found at: {runtime_dll}")
    except ImportError:
        print("[build.spec] Warning: pythonnet not installed")

a = Analysis(
    ['main.py'],
    pathex=[project_root],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[pywebview_hooks] if os.path.isdir(pywebview_hooks) else [],
    hooksconfig={},
    runtime_hooks=[os.path.join(project_root, 'hooks/rthook_pythonnet.py')] if sys.platform == 'win32' else [],
    excludes=[
        # Directory selection no longer uses Tk, so keep Tcl/Tk out of desktop bundles.
        'tkinter',
        '_tkinter',
        'tcl',
        'tk',
        'FixTk',
        # These can be present in local dev environments but are not runtime dependencies.
        'playwright',
        'selenium',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# macOS: 打包为 .app bundle
if sys.platform == 'darwin':
    exe = EXE(
        pyz,
        a.scripts,
        exclude_binaries=True,  # 为 BUNDLE 准备
        name='better-douyin',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=True,  # macOS 需要启用
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=icon_path,
    )
    # 创建 .app bundle
    coll = BUNDLE(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name='better-douyin.app',
        icon=icon_path,
        bundle_identifier='com.anyujia.better-douyin.python',
        info_plist={
            'NSPrincipalClass': 'NSApplication',
            'NSHighResolutionCapable': 'True',
            'CFBundleShortVersionString': app_version,
            'CFBundleVersion': app_version,
            'CFBundleName': 'better-douyin',
            'CFBundleDisplayName': 'better-douyin',
        }
    )
# Windows: 打包为文件夹模式（启动更快）
elif sys.platform == 'win32':
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,  # 使用文件夹模式
        name='better-douyin',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=icon_path,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name='better-douyin',
    )
# Linux: 打包为文件夹
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='better_douyin',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=icon_path,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=[],
        name='better_douyin',
    )
