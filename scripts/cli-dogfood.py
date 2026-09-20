#!/usr/bin/env python3
"""Exercise installed CLIs in disposable directories; preserve logs and failures.

No mocks, internal imports, live fleet writes, GitHub writes, or cleanup.
Run each scenario as a separate CI job after installing the candidate CLI.
"""
import argparse
import json
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
print(f"Evidence: {root}", flush=True)
aw = json.loads(args.agentwheel_command) + ["--no-update-check"]


def run(command, cwd=root, *, required=True):
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True,
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
    assert all(path.read_bytes() == skill.read_bytes() for path in paths)

fleet()
print("PASS", flush=True)
