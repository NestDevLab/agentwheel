import type { RuntimeTarget } from "../runtime/target.js";
import { localTransport } from "./local.js";
import { createSshTransport } from "./ssh.js";
import type { TargetTransport } from "./types.js";

export type { SshTransportConfig, TargetTransport, TransportKind } from "./types.js";

export function transportForTarget(target: RuntimeTarget): TargetTransport {
  if (target.transport === "local") return localTransport;
  if (!target.ssh) throw new Error(`SSH target ${target.agentName ?? target.targetRoot} is missing SSH connection details.`);
  return createSshTransport(target.ssh);
}

export { localTransport, createSshTransport };
