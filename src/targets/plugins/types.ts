export type SemanticPluginRuntime = "openclaw" | "claude" | "codex" | "copilot" | "hermes";

export interface SemanticPluginSpec {
  runtime: SemanticPluginRuntime;
  pluginName: string;
  marketplaceName?: string;
  stateRoot?: string;
  installCommands: string[][];
  uninstallCommands: string[][];
  enableCommands?: string[][];
  disableCommands?: string[][];
}
