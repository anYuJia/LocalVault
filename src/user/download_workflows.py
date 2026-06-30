"""用户作品下载流程拆分模块。

从 UserManager / FavoritesService 中拆出的下载主流程：下载用户全部作品、
下载点赞视频、下载点赞作者的全部作品。DownloadWorkflows 持有 UserManager
实例引用，复用 api、downloader、socketio、媒体信息与下载地址选择等能力。
原方法保留为薄代理，确保外部调用兼容。
"""
import asyncio

from src.config.config import Config
from src.downloader.async_downloads import download_media_group_async, download_video_async
from src.downloader.filename_builder import build_download_name


class DownloadWorkflows:
    """用户作品下载流程服务。"""

    def __init__(self, manager):
        self._mgr = manager

    @property
    def downloader(self):
        return self._mgr.downloader

    @property
    def socketio(self):
        return self._mgr.socketio

    @property
    def debug_mode(self) -> bool:
        return self._mgr.debug_mode

    @property
    def favorites(self):
        return self._mgr.favorites

    async def get_user_videos(self, user_id, offset: int = 0, limit: int = 1000, on_batch=None):
        return await self._mgr.get_user_videos(user_id, offset=offset, limit=limit, on_batch=on_batch)

    def _get_media_info(self, post: dict):
        return self._mgr._get_media_info(post)

    def _media_type_label(self, media_type: str, media_urls: list[dict]) -> str:
        return self._mgr._media_type_label(media_type, media_urls)

    def get_video_download_urls(self, video_data: dict) -> list[str]:
        return self._mgr.get_video_download_urls(video_data)

    async def get_liked_videos(self, count=20, cursor=0, include_pagination=False):
        return await self.favorites.get_liked_videos(count, cursor, include_pagination)

    async def get_liked_authors(self, count=20):
        return await self.favorites.get_liked_authors(count)

    async def download_user_videos(self, user_info: dict, auto_confirm: bool = False, web_socket: bool = False):
        """下载用户视频
        Args:
            user_info: 用户信息
            auto_confirm: 是否自动确认下载（不需要用户输入）
            web_socket: 是否使用WebSocket返回下载进度
        """
        user_id = user_info['sec_uid']
        nickname = user_info.get('nickname', 'unknown')

        # 获取视频列表
        posts = await self.get_user_videos(user_id, limit=200)
        if isinstance(posts, dict):
            error_msg = posts.get('message') or f"未找到用户 {nickname} 的作品"
            if web_socket and self.socketio:
                self.socketio.emit('download_error', {'message': error_msg})
            else:
                print(f"\033[91m{error_msg}\033[0m")
            raise Exception(error_msg)
        if not posts:
            error_msg = f"未找到用户 {nickname} 的作品"
            if web_socket and self.socketio:
                self.socketio.emit('download_error', {'message': error_msg})
            else:
                print(f"\033[91m{error_msg}\033[0m")
            raise Exception(error_msg)

        # 过滤出磁盘上仍然存在的已下载作品；如果用户删除了文件，允许重新下载。
        new_posts = [
            post for post in posts
            if not self.downloader._is_aweme_downloaded(post['aweme_id'], nickname)
        ]

        if not new_posts:
            info_msg = f"用户 {nickname} 没有新作品需要下载"
            if web_socket and self.socketio:
                self.socketio.emit('download_info', {'message': info_msg})
            else:
                print(f"\033[93m{info_msg}\033[0m")
            return

        found_msg = f"找到 {len(new_posts)} 个新作品"
        if web_socket and self.socketio:
            self.socketio.emit('download_info', {'message': found_msg})
        else:
            print(f"\n\033[36m{found_msg}\033[0m")

        # 如果是自动确认模式或WebSocket模式，直接下载所有作品
        if auto_confirm or web_socket:
            selected_posts = new_posts
        else:
            # 显示作品列表
            for i, post in enumerate(new_posts):
                media_type, urls = self._get_media_info(post)
                type_str = self._media_type_label(media_type, urls)

                print(f"\033[36m{i}. [{type_str}] {post['desc']}\033[0m")

            # 处理用户输入
            str_sub = input("\033[31m请输入要下载的序号\n1. 单个数字下载单个作品，多个数字用空格隔开下载多个作品\n2. 片段用-隔开\n3. 直接回车下载全部\033[0m\n")

            selected_posts = []
            if str_sub:
                for part in str_sub.split():
                    if '-' in part:
                        start, end = map(int, part.split('-'))
                        selected_posts.extend(new_posts[start:end+1])
                    else:
                        selected_posts.append(new_posts[int(part)])
            else:
                selected_posts = new_posts

        # 下载选中的作品
        for i, post in enumerate(selected_posts, 1):
            media_type, urls = self._get_media_info(post)
            type_str = self._media_type_label(media_type, urls)

            progress_msg = f"正在下载第 {i}/{len(selected_posts)} 个 [{type_str}]"
            if web_socket and self.socketio:
                self.socketio.emit('download_progress', {
                    'current': i,
                    'total': len(selected_posts),
                    'message': progress_msg,
                    'type': type_str
                })
            else:
                print(f"\033[36m{progress_msg}\033[0m")

            aweme_id = post['aweme_id']
            name = build_download_name(
                nickname,
                post.get('desc', ''),
                aweme_id,
                media_type=media_type,
                create_time=post.get('create_time'),
            )

            if not urls:
                error_msg = f"无法获取媒体URL: {post['desc']}"
                if web_socket and self.socketio:
                    self.socketio.emit('download_error', {'message': error_msg})
                else:
                    print(f"\033[91m{error_msg}\033[0m")
                continue

            if media_type in ['mixed', 'live_photo', 'image']:
                success = await download_media_group_async(
                    self.downloader,
                    urls,
                    name,
                    aweme_id,
                )
                if success:
                    success_msg = f"作品 {name} 下载完成"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_success', {'message': success_msg})
                    else:
                        print(f"\033[92m{success_msg}\033[0m")
                else:
                    error_msg = f"作品 {name} 下载失败"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_error', {'message': error_msg})
                    else:
                        print(f"\033[91m{error_msg}\033[0m")

            elif media_type == 'video':
                fallback_urls = self.get_video_download_urls(post.get('video') or {})
                success = await download_video_async(
                    self.downloader,
                    urls[0]['url'],
                    name,
                    aweme_id,
                    fallback_urls=fallback_urls,
                )
                if success:
                    success_msg = f"作品 {name} 下载完成"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_success', {'message': success_msg})
                    else:
                        print(f"\033[92m{success_msg}\033[0m")
                else:
                    error_msg = f"作品 {name} 下载失败"
                    if web_socket and self.socketio:
                        self.socketio.emit('download_error', {'message': error_msg})
                    else:
                        print(f"\033[91m{error_msg}\033[0m")
            else:
                error_msg = f"未知的媒体类型: {post['desc']}"
                if web_socket and self.socketio:
                    self.socketio.emit('download_error', {'message': error_msg})
                else:
                    print(f"\033[91m{error_msg}\033[0m")

    async def download_liked_videos(self, count=20):
        """下载点赞视频"""
        try:
            videos = await self.get_liked_videos(count)
            if isinstance(videos, dict):
                return 0
            if not videos:
                return 0

            max_workers = max(1, int(getattr(Config, 'MAX_CONCURRENT', 3) or 1))
            semaphore = asyncio.Semaphore(max_workers)

            async def download_one(video: dict) -> int:
                aweme_id = video.get('aweme_id')
                media_type = video.get('media_type', 'unknown')
                media_urls = video.get('media_urls') or []
                if not aweme_id or not media_urls:
                    return 0

                author_name = (video.get('author') or {}).get('nickname') or 'liked'
                name = build_download_name(
                    author_name,
                    video.get('desc', ''),
                    aweme_id,
                    media_type=media_type,
                    create_time=video.get('create_time'),
                )

                async with semaphore:
                    if media_type == 'video' and len(media_urls) == 1:
                        fallback_urls = self.get_video_download_urls((video.get('video') or {}))
                        success = await download_video_async(
                            self.downloader,
                            media_urls[0]['url'],
                            name,
                            aweme_id,
                            fallback_urls=fallback_urls,
                        )
                    else:
                        success = await download_media_group_async(
                            self.downloader,
                            media_urls,
                            name,
                            aweme_id,
                        )

                return 1 if success else 0

            results = await asyncio.gather(*(download_one(video) for video in videos), return_exceptions=True)
            return sum(result for result in results if isinstance(result, int))
        except Exception as e:
            print(f"\033[91m下载点赞视频时出错: {e}\033[0m")
            return 0

    async def download_liked_authors(self, count=20, selected_sec_uids=None):
        """下载点赞作品的作者的所有作品"""
        try:
            authors = await self.get_liked_authors(count)
            if isinstance(authors, dict):
                return 0
            if not authors:
                return 0

            selected = set(selected_sec_uids or [])
            selected_authors = [
                author for author in authors
                if not selected or author.get('sec_uid') in selected
            ]

            max_workers = max(1, int(getattr(Config, 'MAX_CONCURRENT', 3) or 1))
            semaphore = asyncio.Semaphore(max_workers)

            async def download_one_author(author: dict) -> int:
                async with semaphore:
                    print(f"\n\033[36m正在处理作者: {author['nickname']}\033[0m")
                    await self.download_user_videos(author, auto_confirm=True)
                return 1

            results = await asyncio.gather(
                *(download_one_author(author) for author in selected_authors),
                return_exceptions=True,
            )
            return sum(result for result in results if isinstance(result, int))

        except Exception as e:
            print(f"\033[91m处理失败：{str(e)}\033[0m")
            return 0
