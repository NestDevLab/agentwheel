#!/usr/bin/env python3
"""Verify metadata-only migration on a disposable copy of an existing snapshot.

Never accesses a live service root. The operator supplies an already captured,
readable snapshot containing .agentwheel and its claimed runtime paths.
"""
import argparse
import hashlib
import json
from pathlib import Path
import os
import shutil
import stat
import subprocess
import tempfile


def snapshot(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.relative_to(root).parts[0] == '.agentwheel':
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f'Symlinks are unsupported in this copy check: {path}')
        result[str(path.relative_to(root))] = [stat.S_IMODE(info.st_mode),
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot-root', type=Path, required=True)
    parser.add_argument('--source-state-key', required=True)
    parser.add_argument('--current-owner', required=True, help='exact owner string after any separately reviewed handoff')
    parser.add_argument('--cli', type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--apply', action='store_true', help='also apply on the disposable copy and verify runtime equality')
    args = parser.parse_args()
    source = args.snapshot_root.resolve(strict=True)
    cli = args.cli.resolve(strict=True)
    if source == Path('/') or not (source / '.agentwheel').is_dir():
        raise RuntimeError('Expected an already captured snapshot with .agentwheel metadata')
    if any(path.is_symlink() for path in source.rglob('*')):
        raise RuntimeError('Copy check refuses symlinks')
    key = args.source_state_key
    if not key or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in key):
        raise RuntimeError('Source state key must be canonical')
    base = Path(tempfile.mkdtemp(prefix='aw-legacy-copy-'))
    target, workspace, pack = base / 'target', base / 'workspace', base / 'pack'
    shutil.copytree(source, target, symlinks=True)
    state = json.loads((target / '.agentwheel' / f'{key}.install-manifest.json').read_text())
    adapter, installation_type = state['adapter'], state['installationType']
    if adapter not in ('openclaw', 'claude', 'codex', 'copilot', 'hermes'):
        raise RuntimeError('Copy checker currently supports built-in adapters only')
    if not any(entry.get('workspaceOwner') == args.current_owner for entry in state['entries']):
        raise RuntimeError('No source entries have the exact selected current owner')
    # Rebase only metadata in the disposable copy; runtime bytes remain untouched.
    # The copy uses an isolated plain workspace instead of the real registered fleet.
    for path in (target / '.agentwheel').glob('*.install-manifest.json'):
        manifest = json.loads(path.read_text())
        manifest['targetRoot'] = str(target)
        for entry in manifest['entries']:
            if entry.get('workspaceOwner') == args.current_owner:
                entry['workspaceOwner'] = f'workspace-root:{workspace}'
        path.write_text(json.dumps(manifest, indent=2) + '\n')
    (workspace / '.agentwheel').mkdir(parents=True)
    pack.mkdir()
    config = {'schemaVersion': 4,
        'agents': {'copy': {'adapter': adapter, 'root': str(target), 'transport': 'local', 'installationType': installation_type}},
        # Migration resolves identity only: no sources are installed or executed.
        'packages': [{'name': 'copy-selection', 'source': str(pack), 'driver': 'local', 'mode': 'pinned', 'installationType': installation_type}],
        'mutationPolicy': {'reason': 'required', 'journal': 'required', 'revisioning': {'mode': 'off'}}}
    (workspace / '.agentwheel/config.json').write_text(json.dumps(config, indent=2) + '\n')
    env = {**os.environ, 'HOME': str(target), 'AGENTWHEEL_MUTATION_STATE_ROOT': str(base / 'receipts')}
    command = [args.node, str(cli), 'ownership', 'migrate-legacy', '--local', '--agent', 'copy', '--source-state-key', key]
    def run(extra):
        return subprocess.run(command + extra, cwd=workspace, env=env, check=True, capture_output=True, text=True).stdout
    before = snapshot(target)
    plan = json.loads(run(['--json']))
    (base / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(f'Evidence directory: {base}', flush=True)
    print(f'Plan digest: {plan["planDigest"]}; selected entries: {len(plan["selected"])}', flush=True)
    if not plan['selected']:
        raise RuntimeError('Expected a nonempty migration plan')
    if args.apply:
        applied = run(['--apply', '--json', '--reason', 'Verify reviewed migration on disposable snapshot copy',
            '--plan-digest', plan['planDigest'], '--expected-source-revision', plan['source']['revision'] or 'absent',
            '--expected-destination-revision', plan['destination']['revision'] or 'absent',
            '--expected-inventory-revision', plan['manifestInventoryRevision']])
        (base / 'applied.json').write_text(applied)
        if snapshot(target) != before:
            raise RuntimeError('Runtime bytes or modes changed in disposable copy')
        repeated = json.loads(run(['--json']))
        if repeated['selected']:
            raise RuntimeError('Migration was not idempotent')
        (base / 'after.json').write_text(json.dumps(repeated, indent=2) + '\n')
        print('PASS: copied claims migrated, runtime bytes/modes unchanged, rerun is a no-op')
    elif snapshot(target) != before:
        raise RuntimeError('Plan changed runtime files')


if __name__ == '__main__':
    main()
