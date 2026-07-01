"""Flask 子进程入口。

在独立子进程中运行 Flask + SocketIO 服务器，与主进程的 pywebview
共享同一个 Python 解释器但拥有独立的 GIL，彻底消除 WebView2 与
Flask 之间的 GIL 竞争。
"""

import sys
import os


def run_flask_process(port: int, project_root: str, exit_event=None, gui_queue=None, startup_token: str = "") -> None:
    """子进程入口函数。"""
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    os.chdir(project_root)
    os.environ['USE_PYWEBVIEW'] = '1'
    if startup_token:
        os.environ['BETTER_DOUYIN_STARTUP_TOKEN'] = startup_token

    if sys.platform == 'win32':
        import asyncio
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        except Exception:
            pass

    from src.web.web_app import start_server, set_main_process_exit_event, set_gui_queue
    if exit_event is not None:
        set_main_process_exit_event(exit_event)
    if gui_queue is not None:
        set_gui_queue(gui_queue)
    start_server(port=port)
