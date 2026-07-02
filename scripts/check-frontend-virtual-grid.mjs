import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function resolveRepoRoot() {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "frontend/src"))) return cwd;
  if (path.basename(cwd) === "frontend" && existsSync(path.join(cwd, "src"))) {
    return path.dirname(cwd);
  }
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

const repoRoot = resolveRepoRoot();

const files = {
  searchGrid: "frontend/src/components/search/video-grid.tsx",
  recommendedFeed: "frontend/src/components/recommended/feed.tsx",
  collectedView: "frontend/src/components/collected/collected-view.tsx",
  likedView: "frontend/src/components/liked/liked-view.tsx",
};

function readProjectFile(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  if (!existsSync(filePath)) {
    fail(relativePath, "file does not exist");
    return "";
  }
  return readFileSync(filePath, "utf8");
}

const failures = [];

function fail(file, reason) {
  failures.push({ file, reason });
}

function requireText(file, source, needle, reason) {
  if (!source.includes(needle)) fail(file, reason);
}

function forbidText(file, source, needle, reason) {
  if (source.includes(needle)) fail(file, reason);
}

function extractFunctionBody(source, functionName) {
  const signature = `function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  if (signatureIndex < 0) return null;

  const nextFunctionIndex = source.indexOf("\nfunction ", signatureIndex + signature.length);
  if (nextFunctionIndex > signatureIndex) {
    return source.slice(signatureIndex, nextFunctionIndex);
  }

  return source.slice(signatureIndex);
}

const searchGrid = readProjectFile(files.searchGrid);
const recommendedFeed = readProjectFile(files.recommendedFeed);
const collectedView = readProjectFile(files.collectedView);
const likedView = readProjectFile(files.likedView);

for (const [label, file] of Object.entries(files)) {
  const source = {
    searchGrid,
    recommendedFeed,
    collectedView,
    likedView,
  }[label];
  requireText(file, source, "VirtualVideoGrid", "must import or use VirtualVideoGrid");
}

const likedPanelBody = extractFunctionBody(likedView, "LikedVideosPanel");
if (!likedPanelBody) {
  fail(files.likedView, "LikedVideosPanel function was not found");
} else {
  requireText(
    files.likedView,
    likedPanelBody,
    "VirtualVideoGrid",
    "LikedVideosPanel must render liked videos with VirtualVideoGrid"
  );
  if (/videos\.map\s*\([\s\S]*?<VideoCard\b/.test(likedPanelBody)) {
    fail(
      files.likedView,
      "LikedVideosPanel must not render the main liked video list with videos.map(<VideoCard>)"
    );
  }
  forbidText(
    files.likedView,
    likedPanelBody,
    "IntersectionObserver",
    "LikedVideosPanel must not keep its own IntersectionObserver"
  );
  forbidText(
    files.likedView,
    likedPanelBody,
    "loadMoreRef",
    "LikedVideosPanel must not keep an outer loadMoreRef"
  );
}

forbidText(
  files.recommendedFeed,
  recommendedFeed,
  "loadMoreRef",
  "recommended feed must rely on VirtualVideoGrid onLoadMore instead of an outer loadMoreRef"
);
forbidText(
  files.recommendedFeed,
  recommendedFeed,
  "IntersectionObserver",
  "recommended feed must not keep an outer IntersectionObserver"
);

if (failures.length > 0) {
  console.error("Frontend virtual grid regression check failed:");
  for (const { file, reason } of failures) {
    console.error(`- ${file}: ${reason}`);
  }
  process.exit(1);
}

console.log("Frontend virtual grid regression check passed.");
