export interface OpenClawPluginInstallRequest {
  path: string;
  dryRun: boolean;
}

export function openClawPluginInstallCommand(request: OpenClawPluginInstallRequest): string[] {
  return ["openclaw", "plugins", "install", "--link", request.path];
}

