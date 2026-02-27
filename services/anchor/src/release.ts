import { createDefaultReleaseCommandRunner } from "./release-command";
import { ReleaseCockpit } from "./release-manager";
import type { JsonObject, RpcId } from "./release-types";

const releaseCockpit = new ReleaseCockpit({
  runner: createDefaultReleaseCommandRunner(),
});

export async function handleAnchorReleaseInspect(id: RpcId, params: JsonObject | null): Promise<JsonObject> {
  return releaseCockpit.handleInspectRpc(id, params);
}

export async function handleAnchorReleaseStart(id: RpcId, params: JsonObject | null): Promise<JsonObject> {
  return releaseCockpit.handleStartRpc(id, params);
}

export async function handleAnchorReleaseStatus(id: RpcId, params: JsonObject | null): Promise<JsonObject> {
  return releaseCockpit.handleStatusRpc(id, params);
}

export { ReleaseCockpit };
export * from "./release-command";
export type * from "./release-types";
