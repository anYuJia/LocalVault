import type { UserInfo, VideoInfo } from "@/lib/tauri";

export function videoAuthorToUserInfo(video: VideoInfo): UserInfo | null {
  const author = video.author;
  if (!author?.sec_uid) return null;

  return {
    uid: author.uid || "",
    sec_uid: author.sec_uid,
    nickname: author.nickname || "未知作者",
    avatar_thumb: author.avatar_thumb || "",
    avatar_medium: author.avatar_medium || "",
    avatar_larger: author.avatar_medium || author.avatar_thumb || "",
    signature: author.signature || "",
    follower_count: author.follower_count || 0,
    following_count: author.following_count || 0,
    total_favorited: 0,
    aweme_count: author.aweme_count || 0,
    favoriting_count: author.favoriting_count || 0,
    is_follow: author.is_follow || false,
    follow_status: author.follow_status || 0,
    unique_id: author.unique_id || "",
    verify_status: author.verify_status || 0,
  };
}
