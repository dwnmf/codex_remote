import { loadSettings } from "./config.ts";
import { handleAuthRequest, authorizeWsRequest } from "./auth.ts";
import { KvStore } from "./kv-store.ts";
import { RelayManager } from "./relay.ts";
import { emptyWithCors, textResponse } from "./utils.ts";
import { serveStatic } from "./static.ts";

const settings = loadSettings();
const kv = await Deno.openKv();
const store = new KvStore(kv, settings);
const relayManager = new RelayManager();
const CANONICAL_ORIGIN = settings.passkeyOrigin.trim();

function buildCanonicalUrl(reqUrl: URL): string | null {
  if (!CANONICAL_ORIGIN) return null;
  try {
    const canonical = new URL(CANONICAL_ORIGIN);
    if (reqUrl.host.toLowerCase() === canonical.host.toLowerCase()) return null;
    return `${canonical.origin}${reqUrl.pathname}${reqUrl.search}`;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const canonicalUrl = buildCanonicalUrl(url);
  if (canonicalUrl && !pathname.startsWith("/ws/")) {
    if (req.method === "GET" || req.method === "HEAD") {
      return Response.redirect(canonicalUrl, 307);
    }
    return textResponse(`Use canonical URL: ${canonicalUrl}`, 421);
  }

  if (pathname === "/ws/client" || pathname === "/ws/anchor") {
    const role = pathname.endsWith("/client") ? "client" : "anchor";
    const auth = await authorizeWsRequest(settings, store, req, role);
    if (!auth) {
      return textResponse("Unauthorised", 401);
    }

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return textResponse("Upgrade required", 426);
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const hub = relayManager.getHub(auth.userId);
    const clientId = role === "client" ? (url.searchParams.get("clientId") ?? "").trim() || null : null;

    hub.registerSocket(socket, role, clientId);
    socket.addEventListener("close", () => {
      hub.removeSocket(socket, role);
      relayManager.removeIfIdle(auth.userId);
    });
    socket.addEventListener("error", () => {
      hub.removeSocket(socket, role);
      relayManager.removeIfIdle(auth.userId);
    });

    return response;
  }

  if (pathname.startsWith("/auth/")) {
    return await handleAuthRequest(settings, store, req, pathname);
  }

  if (req.method === "OPTIONS") {
    return emptyWithCors(settings, req, 204);
  }

  return await serveStatic(pathname);
});
