#!/usr/bin/env python3
"""Privileged local-run-as smoke test for a disposable GitHub Actions runner only.

Creates a synthetic non-login account, exercises the built CLI and default sudo
transport, and deletes that account and its temporary fixture in a finally block.
Never run this script against a persistent host or a real runtime installation.
"""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(argv, *, cwd, env, expected=0):
    print('RUN ' + ' '.join(map(str, argv)), flush=True)
    result = subprocess.run(list(map(str, argv)), cwd=cwd, env=env,
                            capture_output=True, text=True, timeout=180)
    if expected is not None and result.returncode != expected:
        raise RuntimeError(f'Command failed ({result.returncode}): {argv}\n'
                           f'stdout:\n{result.stdout}\nstderr:\n{result.stderr}')
    return result


def tree_snapshot(root):
    """Include bytes, ownership, modes and mtimes; reads may update atime."""
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        require(not stat.S_ISLNK(info.st_mode), f'Unexpected fixture symlink: {path}')
        result[str(path.relative_to(root))] = (
            info.st_mode, info.st_uid, info.st_gid, info.st_mtime_ns,
            path.read_bytes() if path.is_file() else None)
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def smoke(args):
    # Refuse before creating files or invoking account-management commands.
    require(args.isolated_ci and os.environ.get('GITHUB_ACTIONS') == 'true'
            and sys.platform == 'linux' and os.geteuid() == 0,
            'Refusing: requires --isolated-ci, GITHUB_ACTIONS=true, Linux and euid 0 '
            'on a disposable runner; do not run on a persistent host.')
    cli, node = args.cli.resolve(strict=True), args.node.resolve(strict=True)
    require(cli.is_file() and node.is_file(), 'Built CLI and Node executable must be files')
    require(Path('/usr/bin/python3').is_file(), 'Default helper /usr/bin/python3 is required')
    for executable in ('/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/groupdel',
                       '/usr/bin/sudo', '/usr/bin/test', '/usr/sbin/nologin'):
        require(Path(executable).is_file(), f'Required runner tool missing: {executable}')
    old_umask = os.umask(0o077)
    base = Path(tempfile.mkdtemp(prefix='aw-runas-ci-'))
    base.chmod(0o711)
    user = 'awsmoke_' + secrets.token_hex(5)
    created = False
    service_gid = None
    failure = None
    confidentiality_stop = threading.Event()
    confidentiality_thread = None
    confidentiality = {}
    try:
        caller = base / 'caller'
        caller.mkdir(mode=0o700)
        caller_home, workspace, pack = (caller / name for name in ('home', 'workspace', 'pack'))
        for path in (caller_home, workspace, pack):
            path.mkdir(mode=0o700)
        # Hosted toolcache/checkouts may use group-writable modes. Provision
        # immutable root-owned test tooling instead of weakening code trust.
        tools = base / 'trusted-tools'
        tools.mkdir(mode=0o755)
        tools.chmod(0o755)
        isolated_node = tools / 'node'
        shutil.copyfile(node, isolated_node)
        isolated_node.chmod(0o755)
        node = isolated_node
        distribution = caller / 'dist'
        distribution.mkdir(mode=0o700)
        for name in ('index.js', 'run-as-worker.js', 'run-as-fs.py'):
            shutil.copyfile(cli.parent / name, distribution / name)
            (distribution / name).chmod(0o644)
        # The caller CLI keeps its external dependencies; the service worker
        # is standalone and never traverses this private caller directory.
        (caller / 'node_modules').symlink_to(cli.parent.parent / 'node_modules', target_is_directory=True)
        cli = distribution / 'index.js'
        env = {'AGENTWHEEL_RUN_AS_NODE': str(node), 'HOME': str(caller_home), 'XDG_CONFIG_HOME': str(caller_home / '.config'),
               'XDG_CACHE_HOME': str(caller_home / '.cache'),
               'XDG_STATE_HOME': str(caller_home / '.local/state'),
               'PATH': str(node.parent) + ':/usr/local/bin:/usr/bin:/bin'}
        service_home = base / 'service-home'
        sibling = base / 'untouched-sibling'
        sibling.mkdir(mode=0o700)
        (sibling / 'sentinel').write_text('unchanged\n')
        sibling_before = tree_snapshot(sibling)
        run(['/usr/sbin/useradd', '--user-group', '--no-create-home', '--home-dir', service_home,
             '--shell', '/usr/sbin/nologin', user], cwd=base, env=env)
        created = True
        identity = pwd.getpwnam(user)
        service_gid = identity.pw_gid
        require(identity.pw_uid > 0 and identity.pw_gid > 0, 'Expected separate non-root service UID/GID')
        require(identity.pw_shell == '/usr/sbin/nologin', 'Expected non-login account')
        service_home.mkdir(mode=0o700)
        os.chown(service_home, identity.pw_uid, identity.pw_gid)

        skill = pack / 'skills/fixture/SKILL.md'
        skill.parent.mkdir(parents=True, mode=0o700)
        skill.write_text('---\nname: fixture\ndescription: Isolated run-as smoke fixture.\n---\n\nSynthetic fixture.\n')
        settings = pack / 'settings/openclaw.json'
        settings.parent.mkdir(mode=0o700)
        reference = '${AW_SMOKE_EXTERNAL_VALUE}'
        write_json(settings, {'env': {'vars': {'AW_SMOKE_REFERENCE': '${secret:AW_SMOKE_EXTERNAL_VALUE}'}}})
        write_json(pack / 'openpack.json', {
            'schemaVersion': 2, 'name': 'smoke/run-as', 'version': '1.0.0',
            'provides': [{'type': 'skills', 'path': 'skills'},
                         {'type': 'settings', 'path': 'settings/openclaw.json'}]})
        (workspace / '.agentwheel').mkdir(mode=0o700)
        write_json(workspace / '.agentwheel/config.json', {
            'schemaVersion': 4,
            'mutationPolicy': {'reason': 'required', 'journal': 'required', 'revisioning': {'mode': 'off'}},
            'packages': [{'name': 'fixture', 'source': str(pack), 'driver': 'local', 'mode': 'pinned',
                          'adapter': 'openclaw', 'installationType': 'user'}],
            'agents': {'service': {'adapter': 'openclaw', 'root': str(service_home),
                                   'transport': 'local-run-as', 'runAs': user, 'installationType': 'user'}},
            'profiles': {'service': {'runtimes': [{'agent': 'service'}]}}})

        # Caller-owned immutable package, separate from the service's home.
        validator_root = base / 'validator'
        validator_root.mkdir(mode=0o755)
        validator_root.chmod(0o755)
        env['AGENTWHEEL_RUN_AS_OPENCLAW_ROOT'] = str(validator_root)
        validator = validator_root / 'openclaw.mjs'
        validator.write_text("""import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const home = process.env.HOME, config = process.env.OPENCLAW_CONFIG_PATH;
assert.deepEqual(process.argv.slice(2), ['config', 'validate', '--json']);
assert.equal(process.getuid(), fs.statSync(home).uid); assert.notEqual(process.getuid(), 0);
assert.ok(path.dirname(config).startsWith('/tmp/agentwheel-validate-'));
assert.equal(path.basename(config), 'openclaw.json');
assert.notEqual(fs.statSync(config).uid, process.getuid());
assert.equal(fs.statSync(config).mode & 0o777, 0o440);
assert.equal(fs.statSync(path.dirname(config)).mode & 0o777, 0o710);
assert.equal(JSON.parse(fs.readFileSync(config)).env.vars.AW_SMOKE_REFERENCE, '${AW_SMOKE_EXTERNAL_VALUE}');
for (const key of ['AW_SMOKE_EXTERNAL_VALUE', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.equal(process.env[key], undefined);
fs.writeFileSync(path.join(home, 'validator-invocation.json'), JSON.stringify({argv: process.argv.slice(2), uid: process.getuid(), gid: process.getgid(), config}), {mode: 0o600});
const ack = path.join(home, 'validation-confidentiality-ok');
const deadline = Date.now() + 60_000;
while (!fs.existsSync(ack) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
assert.ok(fs.existsSync(ack), 'confidentiality observer timed out');
assert.equal(fs.statSync(ack).uid, process.getuid());
assert.equal(fs.statSync(ack).mode & 0o777, 0o600);
assert.deepEqual(JSON.parse(fs.readFileSync(ack)), {fileReadDenied: true, directoryListDenied: true});
console.log(JSON.stringify({valid: true}));
""")
        validator.chmod(0o644)
        inaccessible = run(['/usr/bin/sudo', '-n', '-u', user, '--', '/usr/bin/test', '-r', skill],
                           cwd=base, env=env, expected=None)
        require(inaccessible.returncode != 0, 'Service user unexpectedly read caller-private source')
        initial_target = tree_snapshot(service_home)
        aw = [node, cli, '--no-update-check', '--reason', 'Isolated CI run-as smoke']
        scope = ['--local', '--profile', 'service']
        # scan reads and validates the source through the real CLI; plan resolves
        # its graph and probes the real service transport without target writes.
        run(aw + ['scan', str(pack), '--local'], cwd=workspace, env=env)
        planned = json.loads(run(aw + ['plan', *scope, '--format', 'json'], cwd=workspace, env=env).stdout)
        require(not planned['applied'] and len(planned['targets']) == 1, 'Unexpected initial plan targets')
        target = planned['targets'][0]
        require(target['targetRoot'] == str(service_home) and target['installationType'] == 'user',
                'Plan did not select the service home/user installation')
        require(not target['hasBlockingChanges'] and target['summary']['create'] == 2,
                f'Expected skill and settings creates: {target}')
        require(tree_snapshot(service_home) == initial_target, 'Initial graph plan wrote to target')
        unrelated = pwd.getpwnam('nobody')
        require(unrelated.pw_uid not in (0, identity.pw_uid)
                and unrelated.pw_gid != identity.pw_gid, 'Expected a distinct unrelated UID/GID')
        invocation = service_home / 'validator-invocation.json'
        ack = service_home / 'validation-confidentiality-ok'

        def acknowledge(value):
            # Root records the result as a private service-owned fixture file.
            pending = ack.with_name(ack.name + '.pending')
            fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, json.dumps(value).encode())
                os.fchown(fd, identity.pw_uid, identity.pw_gid)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.rename(pending, ack)

        def observe_confidentiality():
            try:
                deadline = time.monotonic() + 70
                while not confidentiality_stop.is_set() and time.monotonic() < deadline:
                    try:
                        call = json.loads(invocation.read_text())
                    except (FileNotFoundError, json.JSONDecodeError):
                        confidentiality_stop.wait(0.025)
                        continue
                    config = Path(call['config'])
                    require(config.parent.parent == Path('/tmp')
                            and config.parent.name.startswith('agentwheel-validate-')
                            and config.name == 'openclaw.json', 'Unexpected validation snapshot path')
                    require(config.is_file(), 'Snapshot disappeared before confidentiality checks')
                    # This real third-UID process receives the known filename;
                    # unreadability must come from permissions, not obscurity.
                    probe = r"""import json, os, pathlib, sys
snapshot=pathlib.Path(sys.argv[1])
result={}
for key, action in [('fileReadDenied', snapshot.read_bytes),
                    ('directoryListDenied', lambda: os.listdir(snapshot.parent))]:
    try:
        action()
    except PermissionError:
        result[key]=True
    else:
        raise RuntimeError('Unrelated user unexpectedly accessed '+key)
print(json.dumps(result))
"""
                    command = ['/usr/bin/sudo', '-n', '-u', unrelated.pw_name, '--',
                               '/usr/bin/python3', '-I', '-c', probe, str(config)]
                    print('CHECK unrelated UID snapshot read and directory-list denial', flush=True)
                    result = subprocess.run(command, cwd='/', env=env, capture_output=True,
                                            text=True, timeout=10)
                    require(result.returncode == 0,
                            f'Confidentiality probe failed: {result.stdout} {result.stderr}')
                    checked = json.loads(result.stdout)
                    require(checked == {'fileReadDenied': True, 'directoryListDenied': True},
                            f'Incomplete confidentiality checks: {checked}')
                    require(config.is_file(), 'Snapshot disappeared during confidentiality checks')
                    confidentiality.update(checked)
                    acknowledge(checked)
                    return
                raise RuntimeError('Confidentiality observer did not see the live validation snapshot')
            except Exception as error:
                confidentiality['error'] = str(error)
                if not ack.exists():
                    try:
                        acknowledge({'error': str(error)})
                    except OSError:
                        pass

        confidentiality_thread = threading.Thread(target=observe_confidentiality,
                                                   name='validation-confidentiality', daemon=True)
        confidentiality_thread.start()
        installed = json.loads(run(aw + ['install', *scope, '--format', 'json'], cwd=workspace, env=env).stdout)
        confidentiality_thread.join(timeout=15)
        require(not confidentiality_thread.is_alive(), 'Confidentiality observer did not finish')
        require(confidentiality == {'fileReadDenied': True, 'directoryListDenied': True},
                f'Validation confidentiality checks failed: {confidentiality}')
        require(installed['applied'], 'CLI install did not report apply')
        installed_skill = service_home / '.openclaw/skills/fixture/SKILL.md'
        require(installed_skill.read_bytes() == skill.read_bytes(), 'Installed skill bytes differ')
        installed_settings = service_home / '.openclaw/openclaw.json'
        require(json.loads(installed_settings.read_text())['env']['vars']['AW_SMOKE_REFERENCE'] == reference,
                'Literal environment reference was not preserved')
        call = json.loads((service_home / 'validator-invocation.json').read_text())
        require(call['argv'] == ['config', 'validate', '--json']
                and (call['uid'], call['gid']) == (identity.pw_uid, identity.pw_gid),
                'Settings validation did not use the allowlisted service operation')
        manifests = list((service_home / '.agentwheel').glob('*.install-manifest.json'))
        require(len(manifests) == 1, 'Expected one partitioned target install manifest')
        manifest = json.loads(manifests[0].read_text())
        key = manifest['stateKey']
        require(key.startswith('openclaw.user.') and len(key) > len('openclaw.user.'),
                f'Expected fingerprint-partitioned user state key: {key}')
        require(manifests[0].name == key + '.install-manifest.json', 'Manifest state-key/path mismatch')
        require(len(manifest['entries']) == 2, 'Expected skill and settings manifest entries')
        for path in [service_home, *service_home.rglob('*')]:
            info = path.lstat()
            require((info.st_uid, info.st_gid) == (identity.pw_uid, identity.pw_gid),
                    f'Wrong service ownership: {path}')
            require(not stat.S_ISLNK(info.st_mode), f'Unexpected target symlink: {path}')
            expected_mode = 0o700 if path.is_dir() else 0o600
            require(stat.S_IMODE(info.st_mode) == expected_mode,
                    f'Wrong target mode: {path}: {stat.S_IMODE(info.st_mode):04o}')
        status = json.loads(run(aw + ['status', *scope, '--installation-type', 'user', '--refresh', '--json'],
                                cwd=workspace, env=env).stdout)
        require(len(status['targets']) == 1 and status['targets'][0]['health'] == 'PASS',
                f'Installed target status failed: {status}')
        before = tree_snapshot(service_home)
        source_before = tree_snapshot(pack)
        replanned = json.loads(run(aw + ['install', *scope, '--dry-run', '--format', 'json'],
                                   cwd=workspace, env=env).stdout)
        require(not replanned['applied'] and len(replanned['targets']) == 1, 'Dry-run unexpectedly applied')
        summary = replanned['targets'][0]['summary']
        require(summary['skip'] == 2 and all(summary[name] == 0 for name in
                ('create', 'update', 'remove', 'drift', 'conflict', 'plugin')), f'Replan was not a no-op: {summary}')
        require(tree_snapshot(service_home) == before, 'Second dry-run wrote to service target')
        require(tree_snapshot(pack) == source_before, 'Second dry-run wrote to private source')
        require(tree_snapshot(sibling) == sibling_before, 'Sibling sentinel changed')
        require(not (caller_home / '.openclaw').exists() and not (workspace / '.openclaw').exists(),
                'Unexpected caller-side runtime output')
        require({path.name for path in base.iterdir()} == {'caller', 'service-home', 'untouched-sibling', 'validator', 'trusted-tools'},
                'Unexpected sibling runtime output')
        # Round-trip one exact claim through reviewed metadata-only CLI plans.
        # Both commands retain the selected source state; the recipient is a
        # separate caller-owned workspace, not a different runtime endpoint.
        recipient = caller / 'recipient-workspace'
        (recipient / '.agentwheel').mkdir(parents=True, mode=0o700)
        write_json(recipient / '.agentwheel/config.json', {
            'schemaVersion': 4, 'packages': [],
            'mutationPolicy': {'reason': 'required', 'journal': 'required', 'revisioning': {'mode': 'off'}}})
        artifact = installed_skill.parent
        artifact_before = tree_snapshot(artifact)
        manifest_before = json.loads(manifests[0].read_text())
        selected_entries = [entry for entry in manifest_before['entries']
                            if entry['artifactType'] == 'skills' and entry['artifactName'] == 'fixture']
        require(len(selected_entries) == 1, 'Expected exactly one handoff claim')
        original_owner = selected_entries[0]['workspaceOwner']
        selected_path = selected_entries[0]['path']
        graph_paths = sorted((workspace / '.agentwheel/locks').rglob('*.graph-lock.json'))
        require(graph_paths, 'Expected caller graph-lock provenance before handoff')
        graph_before = {str(path): path.read_bytes() for path in graph_paths}
        source_locks = {str(path): path.read_bytes() for path in
                        (service_home / '.agentwheel').glob('*.source-lock.json')}
        audit_directory = workspace / '.agentwheel/ownership-handoffs'
        audits_before = set(audit_directory.glob('*.json'))
        for old_workspace, new_workspace in ((workspace, recipient), (recipient, workspace)):
            handoff = aw + ['ownership', 'handoff', 'skills/fixture', *scope,
                            '--source-state-key', key,
                            '--from-workspace-root', str(old_workspace),
                            '--to-workspace-root', str(new_workspace), '--json']
            runtime_before_review = tree_snapshot(service_home)
            reviewed = json.loads(run(handoff + ['--dry-run'], cwd=workspace, env=env).stdout)
            require(tree_snapshot(service_home) == runtime_before_review, 'Handoff dry-run wrote to target')
            require(reviewed['targetRoot'] == str(service_home)
                    and reviewed['stateKey'] == key and reviewed['path'] == selected_path,
                    'Handoff plan selected a different endpoint, manifest or artifact')
            expected_identity = {'user': user, 'uid': identity.pw_uid, 'gid': identity.pw_gid,
                                 'home': str(service_home), 'root': str(service_home)}
            require(reviewed['transport']['identity'] == expected_identity, 'Handoff did not pin service identity')
            fields = [('planDigest', '--plan-digest'),
                      ('manifestInventoryRevision', '--expected-inventory-revision'),
                      ('artifactHash', '--expected-hash'), ('manifestRevision', '--expected-revision')]
            flags = []
            for field, flag in fields:
                value = reviewed.get(field)
                require(isinstance(value, str) and len(value) == 64
                        and all(character in '0123456789abcdef' for character in value),
                        f'Missing reviewed handoff field: {field}')
                flags.extend([flag, value])
            applied = json.loads(run(handoff + flags, cwd=workspace, env=env).stdout)
            require(applied == reviewed, 'Applied handoff differed from its exact reviewed plan')
            require(tree_snapshot(artifact) == artifact_before, 'Ownership handoff changed runtime bytes/modes/UID/GID')
            current = json.loads(manifests[0].read_text())
            transferred = [entry for entry in current['entries'] if entry['path'] == selected_path]
            require(len(transferred) == 1
                    and transferred[0]['workspaceOwner'] == 'workspace-root:' + str(new_workspace),
                    'Service manifest claim did not transfer to the reviewed workspace')
        require(json.loads(manifests[0].read_text())['entries'] == manifest_before['entries'],
                'Round-trip handoff did not restore every original claim')
        require(original_owner == 'workspace-root:' + str(workspace), 'Unexpected original workspace owner')
        new_audits = set(audit_directory.glob('*.json')) - audits_before
        require(len(new_audits) == 2, 'Expected one caller audit per handoff')
        for audit in new_audits:
            info = audit.stat()
            require(info.st_uid == os.geteuid() and info.st_uid != identity.pw_uid
                    and stat.S_IMODE(info.st_mode) == 0o600, 'Handoff audit has wrong caller owner/mode')
            denied = run(['/usr/bin/sudo', '-n', '-u', user, '--', '/usr/bin/test', '-r', audit],
                         cwd=base, env=env, expected=None)
            require(denied.returncode != 0, 'Service user could read a private caller handoff audit')
        require({str(path): path.read_bytes() for path in graph_paths} == graph_before,
                'Handoff changed caller graph provenance')
        require({str(path): path.read_bytes() for path in
                 (service_home / '.agentwheel').glob('*.source-lock.json')} == source_locks,
                'Handoff changed service source-lock provenance')
        final_before = tree_snapshot(service_home)
        final_plan = json.loads(run(aw + ['install', *scope, '--dry-run', '--format', 'json'],
                                    cwd=workspace, env=env).stdout)
        require(not final_plan['applied'] and len(final_plan['targets']) == 1
                and final_plan['targets'][0]['summary']['skip'] == 2
                and not final_plan['targets'][0]['hasBlockingChanges'], 'Round-trip replan was not a no-op')
        require(all(final_plan['targets'][0]['summary'][name] == 0 for name in
                    ('create', 'update', 'remove', 'drift', 'conflict', 'plugin')),
                'Round-trip left pending runtime changes')
        require(tree_snapshot(service_home) == final_before, 'Final round-trip replan wrote to runtime')
        require(tree_snapshot(pack) == source_before and tree_snapshot(sibling) == sibling_before,
                'Ownership round-trip changed source or sibling state')

        # Release is an explicit final metadata-only action. Do not reinstall
        # afterward: retaining the runtime bytes without a claim is intentional.
        release = aw + ['ownership', 'release-claim', 'skills/fixture', *scope,
                        '--state-key', key, '--from-workspace-root', str(workspace),
                        '--path', selected_path, '--json']
        release_before = tree_snapshot(service_home)
        reviewed_release = json.loads(run(release, cwd=workspace, env=env).stdout)
        require(tree_snapshot(service_home) == release_before, 'Release dry-run wrote to runtime')
        released = json.loads(run(release + ['--apply', '--plan-digest', reviewed_release['planDigest'],
                                             '--expected-source-revision', reviewed_release['source']['revision'],
                                             '--expected-inventory-revision', reviewed_release['manifestInventoryRevision']],
                                  cwd=workspace, env=env).stdout)
        require(released['applied'] and released['retainedEntries'] == 1, 'Reviewed claim release did not apply exactly')
        require(tree_snapshot(artifact) == artifact_before, 'Claim release changed runtime bytes/modes/UID/GID')
        expected_entries = [entry for entry in manifest_before['entries'] if entry['path'] != selected_path]
        require(json.loads(manifests[0].read_text())['entries'] == expected_entries,
                'Claim release changed unrelated settings ownership')
        release_audit = Path(released['auditPath'])
        require(release_audit.parent == workspace / '.agentwheel/ownership-releases'
                and release_audit.stat().st_uid == os.geteuid()
                and stat.S_IMODE(release_audit.stat().st_mode) == 0o600, 'Release audit was not caller-private')
        denied = run(['/usr/bin/sudo', '-n', '-u', user, '--', '/usr/bin/test', '-r', release_audit],
                     cwd=base, env=env, expected=None)
        require(denied.returncode != 0, 'Service user could read the private caller release audit')
        require({str(path): path.read_bytes() for path in graph_paths} == graph_before
                and {str(path): path.read_bytes() for path in
                     (service_home / '.agentwheel').glob('*.source-lock.json')} == source_locks,
                'Claim release changed source graph/lock provenance')

        print('PASS: sudo/explicit Node/Python transport, private source, service validation, '
              'unrelated UID snapshot read/list denial, '
              'ownership/modes, manifest partitioning, status, reviewed handoff round-trip/no-op replan and claim release', flush=True)
    except Exception as error:
        failure = error
    finally:
        cleanup_errors = []
        confidentiality_stop.set()
        if confidentiality_thread is not None:
            confidentiality_thread.join(timeout=15)
            if confidentiality_thread.is_alive():
                cleanup_errors.append('Confidentiality observer did not stop before fixture cleanup')
        cleanup_env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}
        if created:
            try:
                run(['/usr/sbin/userdel', user], cwd='/', env=cleanup_env)
            except Exception as error:
                cleanup_errors.append(str(error))
            try:
                # userdel may already delete its private primary group.
                group = grp.getgrnam(user)
                require(group.gr_gid == service_gid, 'Refusing to delete a changed fixture group')
                run(['/usr/sbin/groupdel', user], cwd='/', env=cleanup_env)
            except KeyError:
                pass
            except Exception as error:
                cleanup_errors.append(str(error))
        try:
            shutil.rmtree(base)
        except Exception as error:
            cleanup_errors.append(str(error))
        os.umask(old_umask)
        if cleanup_errors:
            raise RuntimeError('Fixture cleanup failed: ' + '; '.join(cleanup_errors)) from failure
    if failure:
        raise failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated-ci', action='store_true')
    parser.add_argument('--cli', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    args = parser.parse_args()
    try:
        smoke(args)
    except Exception as error:
        print(f'FAIL: {error}', file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
