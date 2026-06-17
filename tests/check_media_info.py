from src.user.user_manager import DouyinUserManager


def test_live_photo_does_not_add_static_cover_as_extra_media():
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

    assert media_type == "live_photo"
    assert media_urls == [
        {
            "type": "live_photo",
            "url": "https://example.com/live-photo.mp4",
        },
    ]
