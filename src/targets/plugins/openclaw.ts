export interface OpenClawPluginInstallRequest {
  path: string;
  dryRun: boolean;
}

export function openClawPluginInstallCommand(request: OpenClawPluginInstallRequest): string[] {
  // OpenClaw copies local plugin paths by default. Avoid --link for fleet-managed
  // installs so runtime profiles do not depend on source-checkout symlinks.
  return ["openclaw", "plugins", "install", "--force", request.path];
}
