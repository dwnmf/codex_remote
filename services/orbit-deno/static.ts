const STATIC_ROOT = new URL("../../dist/", import.meta.url);

const EXT_MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/index.html";
  const cleaned = pathname.replace(/\\/g, "/");
  const segments = cleaned
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..");
  return `/${segments.join("/")}`;
}

function extname(pathname: string): string {
  const idx = pathname.lastIndexOf(".");
  if (idx < 0) return "";
  return pathname.slice(idx).toLowerCase();
}

export async function serveStatic(pathname: string): Promise<Response> {
  const normalized = normalizePath(pathname);
  const pathForFile = normalized.startsWith("/") ? normalized.slice(1) : normalized;

  const serveFile = async (relativePath: string): Promise<Response | null> => {
    try {
      const fileUrl = new URL(relativePath, STATIC_ROOT);
      const data = await Deno.readFile(fileUrl);
      const mime = EXT_MIME[extname(relativePath)] ?? "application/octet-stream";
      return new Response(data, {
        status: 200,
        headers: {
          "content-type": mime,
          "cache-control": relativePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return null;
    }
  };

  const direct = await serveFile(pathForFile);
  if (direct) return direct;

  if (!extname(pathForFile)) {
    const fallback = await serveFile("index.html");
    if (fallback) return fallback;
  }

  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
