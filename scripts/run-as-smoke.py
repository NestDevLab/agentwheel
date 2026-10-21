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
    require(Path('/usr/bin/node').is_file(), 'Default run-as /usr/bin/node is required')
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
    try:
        caller = base / 'caller'
        caller.mkdir(mode=0o700)
        caller_home, workspace, pack = (caller / name for name in ('home', 'workspace', 'pack'))
        for path in (caller_home, workspace, pack):
            path.mkdir(mode=0o700)
        env = {'HOME': str(caller_home), 'XDG_CONFIG_HOME': str(caller_home / '.config'),
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
        write_json(settings, {'env': {'vars': {'AW_SMOKE_REFERENCE': reference}}})
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
assert.equal(fs.statSync(config).mode & 0o777, 0o444);
assert.equal(JSON.parse(fs.readFileSync(config)).env.vars.AW_SMOKE_REFERENCE, '${AW_SMOKE_EXTERNAL_VALUE}');
for (const key of ['AW_SMOKE_EXTERNAL_VALUE', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.equal(process.env[key], undefined);
fs.writeFileSync(path.join(home, 'validator-invocation.json'), JSON.stringify({argv: process.argv.slice(2), uid: process.getuid(), gid: process.getgid(), config}), {mode: 0o600});
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
        installed = json.loads(run(aw + ['install', *scope, '--format', 'json'], cwd=workspace, env=env).stdout)
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
        require({path.name for path in base.iterdir()} == {'caller', 'service-home', 'untouched-sibling', 'validator'},
                'Unexpected sibling runtime output')
        print('PASS: default sudo/Node/Python transport, private source, service validation, '
              'ownership/modes, manifest partitioning, status and read-only no-op replan', flush=True)
    except Exception as error:
        failure = error
    finally:
        cleanup_errors = []
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
