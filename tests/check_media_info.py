from src.user.user_manager import DouyinUserManager


def test_live_photo_keeps_static_image_url_with_live_video():
    manager = object.__new__(DouyinUserManager)
    post = {
        "images": [
            {
                "url_list": [
                    "https://example.com/image-small.webp",
                    "https://example.com/image-large.jpeg",
                ],
                "video": {
                    "play_addr": {
                        "url_list": ["https://example.com/live-photo.mp4"],
                    },
                },
            },
        ],
    }

    media_type, media_urls = manager.get_media_info(post)

    assert media_type == "mixed"
    assert media_urls == [
        {
            "type": "live_photo",
            "url": "https://example.com/live-photo.mp4",
            "fallback_urls": [],
        },
        {
            "type": "image",
            "url": "https://example.com/image-large.jpeg",
            "fallback_urls": ["https://example.com/image-small.webp"],
        },
    ]
