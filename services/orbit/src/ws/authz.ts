import type { AuthResult, Env, Role } from "../types";
import { getAuthToken, verifyOrbitAnchorJwt, verifyOrbitUserJwt } from "../utils/jwt";

export function getRoleFromPath(pathname: string): Role | null {
  const pathOnly = pathname.split("?", 1)[0]?.split("#", 1)[0] ?? "";
  const normalizedPath = pathOnly.length > 1 ? pathOnly.replace(/\/+$/, "") : pathOnly;
  if (normalizedPath === "/ws/client") return "client";
  if (normalizedPath === "/ws/anchor") return "anchor";
  return null;
}

export async function isAuthorised(req: Request, env: Env, role: Role): Promise<AuthResult> {
  const denied: AuthResult = { authorised: false, userId: null, jwtType: null };
  if (role !== "client" && role !== "anchor") {
    console.warn(`[orbit] auth: unsupported role "${String(role)}", denying request`);
    return denied;
  }

  const userSecret = env.CODEX_REMOTE_WEB_JWT_SECRET?.trim();
  const anchorSecret = env.CODEX_REMOTE_ANCHOR_JWT_SECRET?.trim();
  if (role === "client" && !userSecret) {
    console.error("[orbit] auth: web secret not configured, denying client request");
    return denied;
  }
  if (role === "anchor" && !anchorSecret) {
    console.error("[orbit] auth: anchor secret not configured, denying anchor request");
    return denied;
  }

  const provided = (getAuthToken(req) ?? "").trim();
  if (!provided) {
    console.warn("[orbit] auth: missing token");
    return denied;
  }

  if (role === "client") {
    const user = await verifyOrbitUserJwt(provided, env);
    if (user.ok && user.userId) {
      console.log(`[orbit] auth: web JWT accepted, userId=${user.userId}`);
      return { authorised: true, userId: user.userId, jwtType: "web" };
    }
    if (user.ok) {
      console.warn("[orbit] auth: client token missing subject");
    }
    console.warn("[orbit] auth: client token rejected");
    return denied;
  }

  const anchor = await verifyOrbitAnchorJwt(provided, env);
  if (anchor.ok && anchor.userId) {
    console.log(`[orbit] auth: anchor JWT accepted, userId=${anchor.userId}`);
    return { authorised: true, userId: anchor.userId, jwtType: "anchor" };
  }
  if (anchor.ok) {
    console.warn("[orbit] auth: anchor token missing subject");
  }

  console.warn("[orbit] auth: anchor token rejected");
  return denied;
}
