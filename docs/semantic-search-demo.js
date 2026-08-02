import {
  classifyDiscoveryIntent,
  companionSkillSetupCommand,
  groupSemanticResults,
  prepareSemanticQuery,
  rerankSemanticCandidates,
} from "./semantic-search-core.js";

const DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/NestDevLab/agentwheel-registry/main/catalogue-semantic-index/gte-v1/";
const demo = document.querySelector("#semantic-demo");

if (demo) {
  const form = demo.querySelector("#semantic-form");
  const input = demo.querySelector("#semantic-query");
  const submit = demo.querySelector("#semantic-submit");
  const status = demo.querySelector("#semantic-status");
  const progressWrap = demo.querySelector("#semantic-progress-wrap");
  const progressBar = demo.querySelector("#semantic-progress");
  const progressLabel = demo.querySelector("#semantic-progress-label");
  const results = demo.querySelector("#semantic-results");
  const engine = createWorkerClient(updateProgress);
  let engineReady = false;

  demo.querySelectorAll("[data-semantic-example]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.semanticExample;
      input.focus();
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      setStatus("Enter an English capability request.", "warning");
      input.focus();
      return;
    }
    if (classifyDiscoveryIntent(query).action === "abstain") {
      clearResults();
      hideProgress();
      setStatus("That looks conversational, so no model or index was loaded.", "quiet");
      return;
    }

    submit.disabled = true;
    clearResults();
    try {
      const preparedQuery = prepareSemanticQuery(query);
      const catalogueSource = window.agentwheelCatalogue;
      if (!catalogueSource) throw new Error("The semantic catalogue source is unavailable.");
      if (typeof catalogueSource.load === "function") {
        showProgress();
        progressBar.value = 2;
        progressLabel.textContent = "Loading catalogue metadata";
        setStatus("Preparing semantic search in your browser…", "loading");
      }
      const catalogue = await (typeof catalogueSource.load === "function"
        ? catalogueSource.load()
        : catalogueSource.ready);
      if (catalogue.error) throw new Error("The catalogue could not be loaded. The semantic demo is unavailable.");
      if (!catalogue.digests.enriched || !catalogue.digests.vercel) {
        throw new Error("The complete catalogue is required before semantic search can start.");
      }
      if (!engineReady) {
        showProgress();
        setStatus("Preparing private semantic search in your browser…", "loading");
        await engine.request("load", {
          indexBaseUrl: semanticIndexUrl(),
          catalogueDigests: catalogue.digests,
        });
        engineReady = true;
      }
      setStatus("Searching by meaning in your browser…", "loading");
      const response = await engine.request("search", { query: preparedQuery.embeddingText });
      hideProgress();
      if (response.decision.action === "abstain") {
        setStatus("No high-confidence skill match. Try making the capability more specific.", "quiet");
        return;
      }
      const candidates = rerankSemanticCandidates(response.candidates, catalogue.entries, preparedQuery.intent);
      const grouped = groupSemanticResults(candidates, catalogue.entries, 3);
      if (!grouped.length) {
        setStatus("The index found candidates, but they are not present in the loaded catalogue snapshot.", "warning");
        return;
      }
      renderResults(grouped);
      setStatus(`Found ${grouped.length} ${grouped.length === 1 ? "capability" : "capabilities"} in ${response.elapsedMs} ms.`, "success");
    } catch (error) {
      hideProgress();
      setStatus(error instanceof Error ? error.message : "Semantic search could not be loaded.", "warning");
    } finally {
      submit.disabled = false;
      submit.textContent = engineReady ? "Search again" : "Try semantic search";
    }
  });

  function updateProgress(update) {
    showProgress();
    const ranges = {
      runtime: [0, 5],
      model: [5, 80],
      index: [80, 100],
    };
    if (ranges[update.stage]) {
      const [start, end] = ranges[update.stage];
      progressBar.value = start + ((end - start) * update.fraction);
    }
    const transferred = update.total ? ` · ${formatBytes(update.loaded)} of ${formatBytes(update.total)}` : "";
    progressLabel.textContent = `${update.message}${transferred}`;
  }

  function renderResults(groups) {
    clearResults();
    const heading = document.createElement("h3");
    heading.textContent = "Semantic matches";
    results.appendChild(heading);
    const list = document.createElement("div");
    list.className = "semantic-result-list";
    groups.forEach((group, index) => {
      const article = document.createElement("article");
      article.className = "semantic-result";
      const rank = document.createElement("span");
      rank.className = "semantic-rank";
      rank.textContent = String(index + 1);
      article.appendChild(rank);
      const copy = document.createElement("div");
      const title = document.createElement("h4");
      const link = document.createElement("a");
      link.href = detailUrl(group.entry.id);
      link.textContent = group.entry.name;
      title.appendChild(link);
      copy.appendChild(title);
      const description = document.createElement("p");
      description.textContent = group.entry.description || "No description available.";
      copy.appendChild(description);
      const meta = document.createElement("p");
      meta.className = "semantic-result-meta";
      const sourceCount = group.alternates.length + 1;
      meta.textContent = `${ecosystemLabel(group.entry.ecosystem)}${sourceCount > 1 ? ` · ${sourceCount} sources` : ""}`;
      copy.appendChild(meta);
      article.appendChild(copy);
      list.appendChild(article);
    });
    results.appendChild(list);
    renderAgentBridge();
  }

  function renderAgentBridge() {
    const bridge = document.createElement("section");
    bridge.className = "semantic-agent-bridge";
    const pitch = document.createElement("p");
    pitch.className = "semantic-agent-pitch";
    pitch.textContent = "Like this search? Add it to your CLI and agent.";
    bridge.appendChild(pitch);

    const setup = document.createElement("details");
    setup.className = "semantic-agent-setup";
    const summary = document.createElement("summary");
    summary.textContent = "Show me how";
    setup.appendChild(summary);

    const panel = document.createElement("div");
    panel.className = "semantic-agent-setup-panel";
    const explanation = document.createElement("p");
    explanation.textContent = "Install the CLI and companion skill once. The CLI searches the catalogue. The skill lets your agent suggest up to three matches while you work.";
    panel.appendChild(explanation);

    const runtimes = [
      ["codex", "Codex"],
      ["claude", "Claude"],
      ["openclaw", "OpenClaw"],
      ["hermes", "Hermes"],
      ["copilot", "Copilot"],
    ];
    const tabs = document.createElement("div");
    tabs.className = "semantic-runtime-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Agent runtime");
    const command = document.createElement("code");
    command.id = "semantic-agent-command";
    const runtimeButtons = runtimes.map(([adapter, label], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "semantic-runtime-tab";
      button.dataset.adapter = adapter;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", index === 0 ? "true" : "false");
      button.setAttribute("aria-controls", "semantic-agent-command-panel");
      button.tabIndex = index === 0 ? 0 : -1;
      button.textContent = label;
      tabs.appendChild(button);
      return button;
    });
    panel.appendChild(tabs);

    const commandPanel = document.createElement("div");
    commandPanel.className = "semantic-agent-command";
    commandPanel.id = "semantic-agent-command-panel";
    commandPanel.setAttribute("role", "tabpanel");
    const pre = document.createElement("pre");
    pre.appendChild(command);
    commandPanel.appendChild(pre);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "semantic-agent-copy";
    copy.textContent = "Copy";
    commandPanel.appendChild(copy);
    panel.appendChild(commandPanel);

    const note = document.createElement("p");
    note.className = "semantic-agent-note";
    note.textContent = "Suggestions can appear automatically. Your agent must still ask before installing a recommended artifact.";
    panel.appendChild(note);
    setup.appendChild(panel);
    bridge.appendChild(setup);
    results.appendChild(bridge);

    selectRuntime(runtimeButtons, command, 0);
    runtimeButtons.forEach((button, index) => {
      button.addEventListener("click", () => selectRuntime(runtimeButtons, command, index));
      button.addEventListener("keydown", (event) => {
        let target = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") target = index + 1;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = index - 1;
        if (event.key === "Home") target = 0;
        if (event.key === "End") target = runtimeButtons.length - 1;
        if (target === null) return;
        event.preventDefault();
        const nextIndex = (target + runtimeButtons.length) % runtimeButtons.length;
        selectRuntime(runtimeButtons, command, nextIndex, true);
      });
    });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command.textContent || "");
        copy.textContent = "Copied";
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(command);
        selection?.removeAllRanges();
        selection?.addRange(range);
        copy.textContent = "Select";
      }
      window.setTimeout(() => { copy.textContent = "Copy"; }, 1400);
    });
  }

  function clearResults() {
    while (results.firstChild) results.removeChild(results.firstChild);
  }

  function setStatus(message, tone) {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function showProgress() {
    progressWrap.hidden = false;
  }

  function hideProgress() {
    progressWrap.hidden = true;
  }
}

function selectRuntime(buttons, command, activeIndex, shouldFocus = false) {
  buttons.forEach((button, index) => {
    const active = index === activeIndex;
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active) {
      command.textContent = companionSkillSetupCommand(button.dataset.adapter);
      if (shouldFocus) button.focus();
    }
  });
}

function createWorkerClient(onProgress) {
  const worker = new Worker(new URL("./semantic-search-worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let requestId = 0;
  worker.addEventListener("message", (event) => {
    const message = event.data ?? {};
    if (message.type === "progress") {
      onProgress(message.payload);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "error") request.reject(new Error(message.payload?.message || "Semantic worker failed."));
    else request.resolve(message.payload);
  });
  worker.addEventListener("error", (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message || "Semantic worker failed."));
    pending.clear();
  });
  return {
    request(type, payload) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type, payload });
      });
    },
  };
}

function semanticIndexUrl() {
  const value = new URLSearchParams(location.search).get("semantic-index");
  if (!value || /^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(value) || value.startsWith("//")) return DEFAULT_INDEX_URL;
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin ? url.href : DEFAULT_INDEX_URL;
  } catch {
    return DEFAULT_INDEX_URL;
  }
}

function detailUrl(id) {
  const detailPage = demo?.dataset.detailPage;
  const url = new URL(detailPage || location.href, location.href);
  url.search = detailPage ? location.search : "";
  url.hash = "";
  url.searchParams.set("resource", id);
  return url.href;
}

function ecosystemLabel(value) {
  if (value === "vercel") return "Vercel skills";
  if (value === "mcp-registry") return "MCP registry";
  if (value === "skillkit") return "SkillKit";
  if (value === "openpack") return "OpenPack";
  if (value === "clawhub") return "ClawHub";
  if (value === "official") return "Official";
  return value || "Unknown";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "0 MB";
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} MB`;
}
