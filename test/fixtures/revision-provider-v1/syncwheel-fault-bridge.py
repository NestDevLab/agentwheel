#!/usr/bin/env python3
"""Black-box fault bridge for the real local Syncwheel revision provider."""

import importlib.util
import os
import sys
from pathlib import Path


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def durable_marker(path: Path, phase: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        os.write(descriptor, (phase + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return True


def main() -> int:
    if len(sys.argv) != 4:
        raise RuntimeError("usage: syncwheel-fault-bridge.py <source-root> <phase> <marker>")
    source_root = Path(sys.argv[1]).resolve()
    phase = sys.argv[2]
    marker = Path(sys.argv[3]).resolve()
    scripts = source_root / "scripts"
    sys.path.insert(0, str(scripts))
    import syncwheel_revision_provider as protocol

    syncwheel = load_module("agentwheel_syncwheel_fault_bridge", scripts / "syncwheel.py")

    class FaultBackend(syncwheel.SyncwheelRevisionBackend):
        def checkpoint(self, observed_phase):
            if observed_phase == phase and durable_marker(marker, phase):
                raise protocol.RevisionProviderError(
                    f"injected Agentwheel black-box fault after {phase}"
                )

    return protocol.run_provider_stream(
        FaultBackend(protocol), sys.stdin, sys.stdout, sys.stderr
    )


if __name__ == "__main__":
    raise SystemExit(main())
