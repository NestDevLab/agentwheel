#!/usr/bin/env python3
"""Exercise installed CLIs in disposable directories; preserve logs and failures.

No mocks, internal imports, live fleet writes, GitHub writes, or cleanup.
Run each scenario as a separate CI job after installing the candidate CLI.
"""
import argparse
import json
import os
import shlex
from pathlib import Path
import subprocess
import tempfile
import time


parser = argparse.ArgumentParser()
parser.set_defaults(scenario="fleet")
parser.add_argument("--agentwheel-command", default=json.dumps(["node", str(Path(__file__).resolve().parents[1] / "dist/index.js")]),
                    help="JSON argv prefix, for example [\"node\",\"/path/dist/index.js\"]")
parser.add_argument("--timeout", type=float, default=45)
parser.add_argument("--evidence-dir", type=Path)
args = parser.parse_args()
root = args.evidence_dir.resolve() if args.evidence_dir else Path(tempfile.mkdtemp(prefix=f"cli-dogfood-{args.scenario}-"))
root.mkdir(parents=True, exist_ok=True)
cli_home = root / "home"
cli_home.mkdir(exist_ok=True)
cli_env = {**os.environ, "HOME": str(cli_home), "XDG_CONFIG_HOME": str(cli_home / ".config"),
           "XDG_CACHE_HOME": str(cli_home / ".cache"), "XDG_STATE_HOME": str(cli_home / ".local/state")}
print(f"Evidence: {root}", flush=True)
aw = json.loads(args.agentwheel_command) + ["--no-update-check"]


def run(command, cwd=root, *, required=True):
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=cwd, env=cli_env, capture_output=True,
                                text=True, timeout=args.timeout)
        row = dict(command=command, cwd=str(cwd), rc=result.returncode,
                   stdout=result.stdout, stderr=result.stderr)
    except subprocess.TimeoutExpired as exc:
        row = dict(command=command, cwd=str(cwd), rc=124,
                   stdout=str(exc.stdout or ""), stderr=str(exc.stderr or ""))
    row["seconds"] = round(time.monotonic() - started, 3)
    with (root / "commands.jsonl").open("a") as stream:
        stream.write(json.dumps(row) + "\n")
    print(f"{row['seconds']:.3f}s rc={row['rc']} {' '.join(command)}", flush=True)
    if required and row["rc"]:
        raise RuntimeError(row["stderr"] or row["stdout"])
    return row


def git_identity(repo):
    run(["git", "config", "user.name", "CLI Dogfood"], repo)
    run(["git", "config", "user.email", "cli-dogfood@example.invalid"], repo)


def fleet():
    run(aw + ["--version"])
    pack, workspace = root / "pack", root / "fleet"
    pack.mkdir()
    workspace.mkdir()
    run(aw + ["init", "package", "--target-root", str(pack)], pack)
    run(aw + ["init", "workspace", "--fleet-example", "--target-root", str(workspace)], workspace)
    manifest = json.loads((pack / "openpack.json").read_text())
    manifest["name"] = "smoke/cli-pack"
    (pack / "openpack.json").write_text(json.dumps(manifest, indent=2) + "\n")
    skill = pack / "skills/smoke-hello/SKILL.md"
    skill.parent.mkdir()
    skill.write_text("---\nname: smoke-hello\ndescription: Report the smoke version.\n---\n\nVersion ONE.\n")
    config_path = workspace / ".agentwheel/config.json"
    config = json.loads(config_path.read_text())
    config["packages"] = []
    config["agents"] = {
        f"smoke-{adapter}": {"adapter": adapter, "root": str(workspace / f"runtime-{adapter}"), "transport": "local"}
        for adapter in ("codex", "claude")
    }
    config["profiles"] = {"smoke": {"runtimes": [{"agent": key} for key in config["agents"]]}}
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    run(aw + ["add", str(pack), "--local", "--adapter", "codex", "--installation-type", "local",
              "--mode", "tracking", "--skill", "smoke-hello", "--name", "smoke-pack"], workspace)
    base = ["--local", "--profile", "smoke"]
    plan = json.loads(run(aw + ["install"] + base + ["--dry-run", "--format", "json"], workspace)["stdout"])
    assert len(plan["targets"]) == 2 and all(t["summary"]["create"] == 1 for t in plan["targets"])
    run(aw + ["install"] + base + ["--format", "json"], workspace)
    paths = [workspace / "runtime-codex/.agents/skills/smoke-hello/SKILL.md",
             workspace / "runtime-claude/.claude/skills/smoke-hello/SKILL.md"]
    assert all(path.read_bytes() == skill.read_bytes() for path in paths)
    skill.write_text(skill.read_text().replace("ONE", "TWO"))
    run(aw + ["update", "smoke-pack"] + base + ["--dry-run"], workspace)
    run(aw + ["update", "smoke-pack"] + base, workspace)
    assert all(path.read_bytes() == skill.read_bytes() for path in paths)
    plan = json.loads(run(aw + ["install"] + base + ["--dry-run", "--format", "json"], workspace)["stdout"])
    assert len(plan["targets"]) == 2 and all(t["summary"]["skip"] == 1 and not t["hasBlockingChanges"] for t in plan["targets"])
    status = json.loads(run(aw + ["status"] + base + ["--installation-type", "local", "--refresh", "--json"], workspace)["stdout"])
    assert all(t["health"] == "PASS" for t in status["targets"])


    # Reproduce pre-upgrade metadata alongside state from the real installation.
    stable = next((workspace / "runtime-claude/.agentwheel").glob("*.install-manifest.json"))
    graph_path = next((workspace / ".agentwheel/locks/smoke-claude/claude").glob("*.graph-lock.json"))
    fingerprint = json.loads(graph_path.read_text())["canonical"]["targetFingerprint"]
    legacy_graph = graph_path.with_name(f"{fingerprint}.graph-lock.json")
    legacy_graph.write_bytes(graph_path.read_bytes())
    legacy = json.loads(stable.read_text())
    legacy["stateKey"] = f"claude.local.{fingerprint}"
    legacy["entries"][0]["sourceHash"] = "d" * 64
    legacy_path = stable.with_name(legacy["stateKey"] + ".install-manifest.json")
    legacy_path.write_text(json.dumps(legacy, indent=2) + "\n")
    before = {path: path.read_bytes() for path in [stable, legacy_path, graph_path, legacy_graph, *paths]}
    rejected = run(aw + ["install"] + base + ["--dry-run", "--format", "json"], workspace, required=False)
    assert rejected["rc"] != 0 and "disagreeing contributions" in rejected["stderr"]
    for verb in ["install", "plan"]:
        command = aw + [verb] + base + ["--recover-legacy-state", "--format", "json"]
        if verb == "install": command += ["--dry-run"]
        recovered = json.loads(run(command, workspace)["stdout"])
        assert not recovered.get("applied", False)
        assert len(recovered["targets"]) == 2
        assert all(not target["hasBlockingChanges"] for target in recovered["targets"])
        assert all(path.read_bytes() == contents for path, contents in before.items())
    run(aw + ["install"] + base + ["--recover-legacy-state", "--format", "json"], workspace)
    assert legacy_path.read_bytes() == before[legacy_path]
    assert legacy_graph.read_bytes() == before[legacy_graph]

    # Same-Fleet duplicate ownership can be retired only where the stable
    # manifest already covers every legacy path. Exercise the built CLI end to end.
    named = root / "named-fleet"
    named.mkdir()
    run(aw + ["init", "workspace", "--target-root", str(named)], named)
    named_config_path = named / ".agentwheel/config.json"
    named_config = json.loads(named_config_path.read_text())
    named_config.update({"fleetId": "smoke-fleet", "fleets": {},
                         "packages": json.loads(config_path.read_text())["packages"],
                         "agents": {"smoke-claude": {"adapter": "claude", "root": str(named / "runtime-claude"),
                                                     "transport": "local"}},
                         "profiles": {"smoke": {"runtimes": [{"agent": "smoke-claude"}]}}})
    named_config_path.write_text(json.dumps(named_config, indent=2) + "\n")
    run(aw + ["fleet", "register", "smoke-fleet", "--root", str(named),
              "--required-package", "smoke-pack"], named)
    named_base = ["--fleet", "smoke-fleet", "--agent", "smoke-claude"]
    run(aw + ["install"] + named_base, named)
    named_runtime = named / "runtime-claude"
    stable_manifest = next((named_runtime / ".agentwheel").glob("*.install-manifest.json"))
    stable_graph = next((named / ".agentwheel/locks/smoke-claude/claude").glob("*.graph-lock.json"))
    old_fingerprint = json.loads(stable_graph.read_text())["canonical"]["targetFingerprint"]
    old_graph = stable_graph.with_name(f"{old_fingerprint}.graph-lock.json")
    old_graph.write_bytes(stable_graph.read_bytes())
    old_state = json.loads(stable_manifest.read_text())
    old_state["stateKey"] = f"claude.local.{old_fingerprint}"
    old_state["entries"][0]["sourceHash"] = "d" * 64
    old_manifest = stable_manifest.with_name(old_state["stateKey"] + ".install-manifest.json")
    old_manifest.write_text(json.dumps(old_state, indent=2) + "\n")
    old_lock = stable_manifest.with_name(old_state["stateKey"] + ".source-lock.json")
    stable_lock = stable_manifest.with_name(stable_manifest.name.replace(".install-manifest.json", ".source-lock.json"))
    if stable_lock.exists(): old_lock.write_bytes(stable_lock.read_bytes())
    stable_before = stable_manifest.read_bytes()
    graph_before = stable_graph.read_bytes()
    old_before = old_manifest.read_bytes()
    skill_path = named_runtime / ".claude/skills/smoke-hello/SKILL.md"
    runtime_before = skill_path.read_bytes()
    failed = run(aw + ["plan"] + named_base, named, required=False)
    assert failed["rc"] != 0 and "disagreeing contributions" in failed["stderr"]
    retire_args = ["ownership", "retire-stale", "--from-workspace-root", str(named),
                   "--from-fleet-id", "smoke-fleet", "--to-workspace-root", str(named),
                   "--source-state-key", old_state["stateKey"], "--destination-state-key",
                   json.loads(stable_manifest.read_text())["stateKey"], "--fleet", "smoke-fleet",
                   "--agent", "smoke-claude", "--installation-type", "local", "--json"]
    retirement = json.loads(run(aw + retire_args, named)["stdout"])
    assert len(retirement["selected"]) == len(old_state["entries"])
    assert old_manifest.read_bytes() == old_before and skill_path.read_bytes() == runtime_before
    apply_args = retire_args[:-1] + ["--plan-digest", retirement["planDigest"],
                                  "--expected-source-revision", retirement["source"]["revision"],
                                  "--expected-destination-revision", retirement["destination"]["revision"],
                                  "--expected-inventory-revision", retirement["manifestInventoryRevision"], "--apply", "--json"]
    applied = json.loads(run(aw + apply_args, named)["stdout"])
    assert applied["sourceManifestRemoved"] and not old_manifest.exists() and not old_lock.exists()
    assert stable_manifest.read_bytes() == stable_before and stable_graph.read_bytes() == graph_before
    assert old_graph.read_bytes() == graph_before and skill_path.read_bytes() == runtime_before
    run(aw + ["plan"] + named_base, named)
    run(aw + ["install"] + named_base + ["--dry-run"], named)
    skill.write_text(skill.read_text().replace("TWO", "FOUR"))
    assert skill.read_bytes() != runtime_before
    named_update = run(aw + ["update", "smoke-pack"] + named_base, named)
    assert "Summary: create 0, update 1," in named_update["stdout"]
    assert skill_path.read_bytes() == skill.read_bytes()
    assert skill_path.read_bytes() != runtime_before
    run(aw + ["plan"] + named_base, named)

    # A Codex merge selector embeds the graph node revision. Exact ownership
    # coverage must survive a package revision without weakening artifact identity.
    codex_pack, codex_fleet = root / "codex-pack", root / "codex-fleet"
    codex_pack.mkdir()
    codex_fleet.mkdir()
    run(aw + ["init", "package", "--target-root", str(codex_pack)], codex_pack)
    run(aw + ["init", "workspace", "--target-root", str(codex_fleet)], codex_fleet)
    codex_manifest = json.loads((codex_pack / "openpack.json").read_text())
    codex_manifest.update({"name": "smoke/codex-hooks", "version": "2.0.0",
                           "provides": [{"type": "hooks", "path": "hooks"}, {"type": "mcp", "path": "mcp"}]})
    (codex_pack / "openpack.json").write_text(json.dumps(codex_manifest, indent=2) + "\n")
    (codex_pack / "hooks").mkdir(exist_ok=True)
    (codex_pack / "hooks/events.json").write_text(json.dumps({"hooks": {"managed": [{"command": "echo managed"}]}}) + "\n")
    (codex_pack / "mcp").mkdir(exist_ok=True)
    (codex_pack / "mcp/managed.json").write_text(json.dumps({"mcpServers": {"managed": {"command": "echo"}}}) + "\n")
    codex_config_path = codex_fleet / ".agentwheel/config.json"
    codex_config = json.loads(codex_config_path.read_text())
    codex_config["packages"] = []
    codex_config["agents"] = {"smoke-codex": {"adapter": "codex", "root": str(codex_fleet / "runtime-codex"),
                                                  "transport": "local"}}
    codex_config["profiles"] = {"smoke": {"runtimes": [{"agent": "smoke-codex"}]}}
    codex_config_path.write_text(json.dumps(codex_config, indent=2) + "\n")
    run(aw + ["add", str(codex_pack), "--local", "--adapter", "codex", "--installation-type", "local",
              "--mode", "tracking", "--select", "hooks/events.json", "--select", "mcp/managed.json", "--name", "codex-pack"], codex_fleet)
    codex_config = json.loads(codex_config_path.read_text())
    codex_config.update({"fleetId": "codex-fleet", "fleets": {}})
    codex_config_path.write_text(json.dumps(codex_config, indent=2) + "\n")
    run(aw + ["fleet", "register", "codex-fleet", "--root", str(codex_fleet),
              "--required-package", "codex-pack"], codex_fleet)
    codex_base = ["--fleet", "codex-fleet", "--agent", "smoke-codex"]
    run(aw + ["install"] + codex_base, codex_fleet)
    codex_runtime = codex_fleet / "runtime-codex"
    codex_stable = next((codex_runtime / ".agentwheel").glob("*.install-manifest.json"))
    codex_state = json.loads(codex_stable.read_text())
    assert len(codex_state["entries"]) == 2
    assert {e["mergeStrategy"] for e in codex_state["entries"]} == {"json-deep", "codex-toml-mcp"}
    assert {e["logicalSelector"].split(":", 1)[1] for e in codex_state["entries"]} == {"hooks/events.json", "mcp/managed.json"}
    codex_old = json.loads(codex_stable.read_text())
    codex_old["stateKey"] = "codex.local.legacy-revision"
    for old_entry, codex_entry in zip(codex_old["entries"], codex_state["entries"]):
        old_entry["graphNodeId"] = old_entry["graphNodeId"].replace("@2.0.0+", "@1.0.0+")
        old_entry["logicalSelector"] = old_entry["graphNodeId"] + ":" + codex_entry["logicalSelector"].split(":", 1)[1]
        assert old_entry["logicalSelector"] != codex_entry["logicalSelector"]
    codex_old_path = codex_stable.with_name(codex_old["stateKey"] + ".install-manifest.json")
    codex_old_path.write_text(json.dumps(codex_old, indent=2) + "\n")
    codex_runtime_paths = [codex_runtime / entry["path"] for entry in codex_state["entries"]]
    codex_runtime_before = {path: path.read_bytes() for path in codex_runtime_paths}
    codex_stable_before = codex_stable.read_bytes()
    codex_retire_args = ["ownership", "retire-stale", "--from-workspace-root", str(codex_fleet),
                         "--from-fleet-id", "codex-fleet", "--to-workspace-root", str(codex_fleet),
                         "--source-state-key", codex_old["stateKey"], "--destination-state-key",
                         codex_state["stateKey"], "--fleet", "codex-fleet", "--agent", "smoke-codex",
                         "--installation-type", "local", "--json"]
    changed_mcp = json.loads(codex_old_path.read_text())
    next(entry for entry in changed_mcp["entries"] if entry["mergeStrategy"] == "codex-toml-mcp")["mergeRemoval"]["mcpServers"]["managed"]["command"] = "changed"
    codex_old_path.write_text(json.dumps(changed_mcp, indent=2) + "\n")
    rejected_mcp = run(aw + codex_retire_args, codex_fleet, required=False)
    assert rejected_mcp["rc"] != 0 and "does not exactly cover" in rejected_mcp["stderr"]
    codex_old_path.write_text(json.dumps(codex_old, indent=2) + "\n")
    codex_retirement = json.loads(run(aw + codex_retire_args, codex_fleet)["stdout"])
    assert len(codex_retirement["selected"]) == 2
    assert all(entry["coverage"] == "exact" for entry in codex_retirement["selected"])
    codex_apply_args = codex_retire_args[:-1] + ["--plan-digest", codex_retirement["planDigest"],
                         "--expected-source-revision", codex_retirement["source"]["revision"],
                         "--expected-destination-revision", codex_retirement["destination"]["revision"],
                         "--expected-inventory-revision", codex_retirement["manifestInventoryRevision"], "--apply", "--json"]
    assert json.loads(run(aw + codex_apply_args, codex_fleet)["stdout"])["sourceManifestRemoved"]
    assert not codex_old_path.exists() and codex_stable.read_bytes() == codex_stable_before
    assert all(path.read_bytes() == content for path, content in codex_runtime_before.items())
    run(aw + ["plan"] + codex_base, codex_fleet)
    assert all(path.read_bytes() != skill.read_bytes() for path in paths)
    # Recovery must also permit an actual source update, while retaining legacy evidence.
    skill.write_text(skill.read_text().replace("FOUR", "FIVE"))
    unchanged = {path: path.read_bytes() for path in [stable, legacy_path, graph_path, legacy_graph, *paths]}
    rejected = run(aw + ["update", "smoke-pack"] + base + ["--dry-run"], workspace, required=False)
    assert rejected["rc"] != 0 and "disagreeing contributions" in rejected["stderr"]
    run(aw + ["update", "smoke-pack"] + base + ["--recover-legacy-state", "--dry-run"], workspace)
    assert all(path.read_bytes() == content for path, content in unchanged.items())
    run(aw + ["update", "smoke-pack"] + base + ["--recover-legacy-state"], workspace)
    assert all(path.read_bytes() == skill.read_bytes() for path in paths)
    assert legacy_path.read_bytes() == before[legacy_path]
    assert legacy_graph.read_bytes() == before[legacy_graph]

    # A nested profile under a registered Fleet is refused on paths a plain scratch workspace claimed
    # under a fingerprint-only key. adopt-legacy moves that proven ownership, no force flags needed.
    adopt_runtime, scratch, nested = root / "adopt-runtime", root / "adopt-scratch", named / "profiles/adopt"
    for workspace_root in (scratch, nested):
        workspace_root.mkdir(parents=True)
        run(aw + ["init", "workspace", "--target-root", str(workspace_root)], workspace_root)
        workspace_config_path = workspace_root / ".agentwheel/config.json"
        workspace_config = json.loads(workspace_config_path.read_text())
        workspace_config.update({"packages": json.loads(config_path.read_text())["packages"],
                                 "agents": {"adopt-claude": {"adapter": "claude", "root": str(adopt_runtime),
                                                             "transport": "local"}}})
        workspace_config_path.write_text(json.dumps(workspace_config, indent=2) + "\n")
    adopt_base = ["--local", "--agent", "adopt-claude"]
    run(aw + ["install"] + adopt_base, scratch)
    scratch_manifest = next((adopt_runtime / ".agentwheel").glob("*.install-manifest.json"))
    scratch_graph = next((scratch / ".agentwheel/locks/adopt-claude/claude").glob("*.graph-lock.json"))
    adopt_fingerprint = json.loads(scratch_graph.read_text())["canonical"]["targetFingerprint"]
    adopt_state = json.loads(scratch_manifest.read_text())
    adopt_state["stateKey"] = f"claude.local.{adopt_fingerprint}"
    adopt_legacy = scratch_manifest.with_name(adopt_state["stateKey"] + ".install-manifest.json")
    adopt_legacy.write_text(json.dumps(adopt_state, indent=2) + "\n")
    scratch_graph.with_name(f"{adopt_fingerprint}.graph-lock.json").write_bytes(scratch_graph.read_bytes())
    for current in [scratch_manifest, scratch_graph,
                    scratch_manifest.with_name(scratch_manifest.name.replace(".install-manifest.json", ".source-lock.json"))]:
        if current.exists(): current.unlink()
    adopt_skill = adopt_runtime / ".claude/skills/smoke-hello/SKILL.md"
    adopt_runtime_before = adopt_skill.read_bytes()
    skill.write_text(skill.read_text().replace("FIVE", "SIX"))
    refused = run(aw + ["install"] + adopt_base + ["--dry-run"], nested, required=False)
    assert refused["rc"] != 0 and "another workspace" in refused["stderr"]
    adopt_args = ["ownership", "adopt-legacy", "--source-state-key", adopt_state["stateKey"],
                  "--from-workspace-root", str(scratch), "--agent", "adopt-claude", "--json"]
    adoption = json.loads(run(aw + adopt_args, nested)["stdout"])
    assert adoption["source"]["class"] == "foreign-root" and adoption["destination"]["revision"] is None
    assert [(e["path"], e["action"], e["drift"]) for e in adoption["selected"]] == [(".claude/skills/smoke-hello", "adopt", False)]
    assert adopt_legacy.exists() and adopt_skill.read_bytes() == adopt_runtime_before
    apply_argv = shlex.split(adoption["applyCommand"])
    assert apply_argv[0] == "agentwheel" and apply_argv[-1] == "--apply"
    adopted = json.loads(run(aw + apply_argv[1:] + ["--json"], nested)["stdout"])
    assert adopted["sourceManifestRemoved"] and not adopt_legacy.exists()
    assert adopt_skill.read_bytes() == adopt_runtime_before
    nothing = run(aw + adopt_args, nested, required=False)
    assert nothing["rc"] != 0 and "Nothing to adopt" in nothing["stderr"]
    adopt_plan = json.loads(run(aw + ["install"] + adopt_base + ["--dry-run", "--format", "json"], nested)["stdout"])
    assert len(adopt_plan["targets"]) == 1 and not adopt_plan["targets"][0]["hasBlockingChanges"]
    assert adopt_plan["targets"][0]["summary"]["update"] == 1
    run(aw + ["install"] + adopt_base, nested)
    assert adopt_skill.read_bytes() == skill.read_bytes()
    adopt_noop = json.loads(run(aw + ["install"] + adopt_base + ["--dry-run", "--format", "json"], nested)["stdout"])
    assert adopt_noop["targets"][0]["summary"]["skip"] == 1 and not adopt_noop["targets"][0]["hasBlockingChanges"]

fleet()
print("PASS", flush=True)
