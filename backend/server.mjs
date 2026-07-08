#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const startedAt = new Date().toISOString();
const demoVideoUrl = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const demoCover = "/animated_icon.svg";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-open-shell": "mock-backend",
};

const demoUser = {
  uid: "demo_uid_001",
  sec_uid: "demo_sec_uid_001",
  nickname: "Open Shell Demo",
  avatar_thumb: demoCover,
  signature: "安全 mock 后端返回的示例账号。真实平台连接属于私有适配器边界。",
  follower_count: 12800,
  following_count: 128,
  aweme_count: 36,
};

function json(res, status, body) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function makeVideo(index) {
  return {
    aweme_id: `demo_video_${index}`,
    desc: `公开壳示例视频 ${index}: 数据来自本地 mock 后端。`,
    create_time: Math.floor(Date.now() / 1000) - index * 3600,
    author: demoUser,
    cover_url: demoCover,
    media_type: "video",
    video: {
      play_addr: demoVideoUrl,
      preview_addr: demoVideoUrl,
      cover: demoCover,
      width: 720,
      height: 1280,
      duration: 12,
    },
    statistics: {
      play_count: 10000 + index * 1000,
      digg_count: 800 + index * 20,
      comment_count: 30 + index,
      share_count: 5 + index,
      collect_count: 90 + index * 4,
    },
  };
}

const demoVideos = Array.from({ length: 12 }, (_, index) => makeVideo(index + 1));

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = path.normalize(path.join(distDir, requested));
  if (!candidate.startsWith(distDir)) {
    json(res, 403, { success: false, message: "Forbidden" });
    return;
  }
  const file = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(distDir, "index.html");
  if (!fs.existsSync(file)) {
    json(res, 404, {
      success: false,
      message: "dist/ not found. Run npm run build first.",
    });
    return;
  }
  res.writeHead(200, {
    "content-type": contentType(file),
    "cache-control": "no-store",
    "x-open-shell": "static-preview",
  });
  fs.createReadStream(file).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    json(res, 200, {
      success: true,
      service: "better-douyin-open-shell",
      mode: "mock",
      started_at: startedAt,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    json(res, 200, {
      success: true,
      data: {
        provider: "mock",
        public_shell: true,
        private_platform_connector: false,
        features: ["ui-demo", "mock-data", "static-preview"],
      },
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/account") {
    json(res, 200, { success: true, data: demoUser });
    return;
  }

  if (req.method === "GET" && pathname === "/api/videos") {
    json(res, 200, {
      success: true,
      data: {
        items: demoVideos,
        cursor: 0,
        has_more: false,
      },
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/downloads") {
    json(res, 200, {
      success: true,
      data: [
        {
          id: "demo_task_001",
          title: "公开壳 demo 下载任务",
          status: "completed",
          progress: 100,
          total: 3,
          completed: 3,
        },
      ],
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/ai/suggest") {
    let payload = {};
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : {};
    } catch {
      json(res, 400, { success: false, message: "Invalid JSON body" });
      return;
    }
    json(res, 200, {
      success: true,
      data: {
        suggestion: "这是公开壳 mock 后端生成的 AI 示例回复，可用于调试 UI，不会调用外部模型。",
        received: payload,
      },
    });
    return;
  }

  if (pathname.startsWith("/api/")) {
    json(res, 404, {
      success: false,
      message: "Mock API route not found in public shell backend.",
    });
    return;
  }

  serveStatic(req, res, pathname);
}

if (process.argv.includes("--check")) {
  const required = [
    path.join(rootDir, "backend", "server.mjs"),
    path.join(rootDir, "README.md"),
    path.join(rootDir, "SECURITY_BOUNDARY.md"),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    console.error(`Missing required public shell files:\n${missing.join("\n")}`);
    process.exit(1);
  }
  console.log("mock backend check ok");
  process.exit(0);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    json(res, 500, {
      success: false,
      message: "Mock backend error",
      detail: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(port, host, () => {
  console.log(`better-douyin open shell mock backend: http://${host}:${port}`);
});
