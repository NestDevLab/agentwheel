#!/usr/bin/python3
"""Bounded, fail-closed Linux filesystem protocol. No command execution.

All target resolution uses openat2 below one verified directory descriptor.
Only single-component mkdir/unlink/rename calls use parent directory descriptors.
"""
import argparse
import base64
import ctypes
import errno
import json
import os
import platform
import secrets
import stat
import sys
from contextlib import contextmanager

MAX_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_DEPTH = 64
MAX_REQUEST = 20 * 1024 * 1024
RESOLVE = 0x08 | 0x04 | 0x02  # BENEATH | NO_SYMLINKS | NO_MAGICLINKS
IGNORED = {'.git', 'node_modules', '__pycache__', '.DS_Store'}


class How(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64),
                ('resolve', ctypes.c_uint64)]


def reject(message):
    raise OSError(errno.EINVAL, message)


def relative(path, allow_root=True):
    if not isinstance(path, str) or '\x00' in path or '\\' in path or path.startswith('/'):
        reject('Expected a contained relative path')
    if path in ('', '.') and allow_root:
        return '.'
    parts = path.split('/')
    if len(parts) > MAX_DEPTH or any(p in ('', '.', '..') for p in parts):
        reject('Invalid contained path or depth limit exceeded')
    path.encode('utf-8', 'strict')
    return path


def decode(content):
    if not isinstance(content, str) or len(content) > ((MAX_BYTES + 2) // 3) * 4:
        reject('File content limit exceeded')
    try:
        value = base64.b64decode(content, validate=True)
    except (ValueError, TypeError):
        reject('Invalid base64 file content')
    if len(value) > MAX_BYTES:
        reject('File content limit exceeded')
    return value


class Filesystem:
    def __init__(self, root, uid, gid):
        if sys.platform != 'linux' or platform.machine() not in ('x86_64', 'aarch64', 'riscv64'):
            raise OSError(errno.ENOSYS, 'Supported Linux openat2 architecture required')
        if uid <= 0 or gid < 0 or (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (uid, uid, gid, gid):
            raise OSError(errno.EPERM, 'Pinned non-root UID and GID must match the process')
        if not isinstance(root, str) or not root.startswith('/') or root == '/':
            reject('Expected an absolute non-root directory')
        name = relative(root[1:], False)
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.syscall.restype = ctypes.c_long
        anchor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            self.root = self.open_at(anchor, name, os.O_RDONLY | os.O_DIRECTORY)
        finally:
            os.close(anchor)
        owner = os.fstat(self.root)
        if (owner.st_uid, owner.st_gid) != (uid, gid):
            os.close(self.root)
            raise OSError(errno.EPERM, 'Root directory must have the pinned owner and group')

    def open_at(self, anchor, path, flags, mode=0):
        how = How(flags | os.O_CLOEXEC, mode, RESOLVE)
        fd = self.libc.syscall(ctypes.c_long(437), ctypes.c_int(anchor),
                               ctypes.c_char_p(os.fsencode(path)), ctypes.byref(how), ctypes.sizeof(how))
        if fd < 0:
            code = ctypes.get_errno()
            raise OSError(code, 'Confined openat2 failed: ' + os.strerror(code))
        return fd

    @contextmanager
    def opened(self, path, flags=os.O_PATH, mode=0):
        fd = self.open_at(self.root, relative(path), flags, mode)
        try:
            self.safe(os.fstat(fd))
            yield fd
        finally:
            os.close(fd)

    @staticmethod
    def safe(info):
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            reject('Unsupported special file or symlink')
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            reject('Hardlinked regular files are unsupported')
        return info

    def info(self, path):
        with self.opened(path) as fd:
            return os.fstat(fd)

    def names(self, path):
        with self.opened(path, os.O_RDONLY | os.O_DIRECTORY) as fd:
            names = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    relative(entry.name, False)
                    names.append(entry.name)
                    if len(names) > MAX_ENTRIES:
                        reject('Tree entry limit exceeded')
            return sorted(names)

    def read(self, path):
        with self.opened(path, os.O_RDONLY | os.O_NONBLOCK) as fd:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                reject('Expected a regular file')
            chunks, size = [], 0
            while True:
                chunk = os.read(fd, min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    reject('File content limit exceeded')
                chunks.append(chunk)
            self.safe(os.fstat(fd))
            return b''.join(chunks)

    @staticmethod
    def child(parent, name):
        return name if parent == '.' else parent + '/' + name

    def snapshot(self, path, include_ignored):
        output, size = [], 0

        def visit(target, suffix):
            nonlocal size
            if len(output) >= MAX_ENTRIES or (suffix and len(suffix.split('/')) > MAX_DEPTH):
                reject('Tree entry or depth limit exceeded')
            info = self.info(target)
            entry = {'path': suffix, 'kind': 'dir' if stat.S_ISDIR(info.st_mode) else 'file',
                     'mode': stat.S_IMODE(info.st_mode) & (0o7777 if include_ignored else 0o777)}
            output.append(entry)
            if entry['kind'] == 'dir':
                for name in self.names(target):
                    if not include_ignored and (name in IGNORED or name.endswith(('.pyc', '.pyo'))):
                        continue
                    visit(self.child(target, name), name if not suffix else suffix + '/' + name)
            else:
                data = self.read(target)
                size += len(data)
                if size > MAX_BYTES:
                    reject('Tree content limit exceeded')
                entry['content'] = base64.b64encode(data).decode('ascii')
        visit(relative(path), '')
        return output

    @contextmanager
    def parent(self, path, create=False):
        path = relative(path, False)
        parts = path.split('/')
        prefix = '.'
        if create:
            for part in parts[:-1]:
                with self.opened(prefix, os.O_RDONLY | os.O_DIRECTORY) as fd:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                    else:
                        # Persist the new inode before publishing its parent entry.
                        child = self.child(prefix, part)
                        with self.opened(child, os.O_RDONLY | os.O_DIRECTORY) as child_fd:
                            os.fchmod(child_fd, 0o700)
                            os.fsync(child_fd)
                        os.fsync(fd)
                prefix = self.child(prefix, part)
                with self.opened(prefix, os.O_RDONLY | os.O_DIRECTORY):
                    pass
        parent = '/'.join(parts[:-1]) or '.'
        with self.opened(parent, os.O_RDONLY | os.O_DIRECTORY) as fd:
            yield fd, parts[-1]

    def mkdir(self, path):
        with self.parent(path, True) as (fd, name):
            os.mkdir(name, 0o700, dir_fd=fd)
            with self.opened(path, os.O_RDONLY | os.O_DIRECTORY) as child_fd:
                os.fchmod(child_fd, 0o700)
                os.fsync(child_fd)
            os.fsync(fd)

    def rm(self, path, budget=None):
        path = relative(path, False)  # The pinned root cannot be removed.
        if budget is None:
            budget = [0]
        try:
            info = self.info(path)
        except FileNotFoundError:
            return
        budget[0] += 1
        if budget[0] > MAX_ENTRIES:
            reject('Tree entry limit exceeded')
        if stat.S_ISDIR(info.st_mode):
            for name in self.names(path):
                self.rm(self.child(path, name), budget)
            with self.parent(path) as (fd, name):
                os.rmdir(name, dir_fd=fd)
                os.fsync(fd)
        else:
            with self.parent(path) as (fd, name):
                os.unlink(name, dir_fd=fd)
                os.fsync(fd)

    def write(self, path, data, mode=None):
        path = relative(path, False)
        try:
            info = self.info(path)
            if not stat.S_ISREG(info.st_mode):
                reject('Expected a regular file destination')
            existing_mode = stat.S_IMODE(info.st_mode) & 0o777
        except FileNotFoundError:
            existing_mode = 0o600
        with self.parent(path, True) as (parent, name):
            temp = '.agentwheel-file-' + secrets.token_hex(16)
            fd = self.open_at(parent, temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                try:
                    offset = 0
                    while offset < len(data):
                        count = os.write(fd, data[offset:])
                        if not count:
                            raise OSError(errno.EIO, 'Incomplete file write')
                        offset += count
                    os.fchmod(fd, existing_mode if mode is None else mode)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                # A swapped symlink is replaced as a directory entry, never followed.
                os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            finally:
                try:
                    os.unlink(temp, dir_fd=parent)
                    os.fsync(parent)
                except FileNotFoundError:
                    pass

    @staticmethod
    def validate_snapshot(entries):
        if not isinstance(entries, list) or not entries or len(entries) > MAX_ENTRIES:
            reject('Invalid snapshot entry count')
        parsed, size = {}, 0
        for entry in entries:
            if not isinstance(entry, dict):
                reject('Invalid snapshot entry')
            path = relative(entry.get('path'))
            if path in parsed or entry.get('kind') not in ('file', 'dir'):
                reject('Duplicate or invalid snapshot entry')
            mode = entry.get('mode')
            if type(mode) is not int or mode < 0 or mode > 0o777:
                reject('Invalid snapshot mode')
            data = decode(entry.get('content')) if entry['kind'] == 'file' else None
            size += len(data) if data is not None else 0
            if size > MAX_BYTES:
                reject('Tree content limit exceeded')
            parsed[path] = (entry['kind'], mode, data)
        if '.' not in parsed:
            reject('Snapshot root is missing')
        for path in parsed:
            if path == '.':
                continue
            parent = path.rsplit('/', 1)[0] if '/' in path else '.'
            if parent not in parsed or parsed[parent][0] != 'dir':
                reject('Snapshot hierarchy is incomplete')
        return parsed

    def install(self, path, entries):
        path = relative(path, False)
        parsed = self.validate_snapshot(entries)  # Validate every byte before mutation.
        with self.parent(path, True) as (parent, name):
            temp = '.agentwheel-tree-' + secrets.token_hex(16)
            prefix = path.rsplit('/', 1)[0] if '/' in path else '.'
            staged = self.child(prefix, temp)
            try:
                if parsed['.'][0] == 'file':
                    self.write(staged, parsed['.'][2], parsed['.'][1])
                else:
                    self.mkdir(staged)
                    for suffix in sorted((p for p in parsed if p != '.'), key=lambda p: (p.count('/'), p)):
                        kind, mode, data = parsed[suffix]
                        target = self.child(staged, suffix)
                        if kind == 'dir':
                            self.mkdir(target)
                        else:
                            self.write(target, data, mode)
                    for suffix in sorted(parsed, key=lambda p: -1 if p == '.' else p.count('/'), reverse=True):
                        kind, mode, _ = parsed[suffix]
                        if kind == 'dir':
                            target = staged if suffix == '.' else self.child(staged, suffix)
                            with self.opened(target, os.O_RDONLY | os.O_DIRECTORY) as fd:
                                os.fchmod(fd, mode)
                                os.fsync(fd)
                self.rm(path)
                os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            finally:
                # Successful rename leaves no staging entry. Permission errors fail closed.
                self.rm(staged)

    def execute(self, request):
        if not isinstance(request, dict) or type(request.get('version')) is not int or request['version'] != 1:
            reject('Unsupported protocol version')
        operation = request.get('operation')
        if operation == 'probe':
            with self.opened('.', os.O_RDONLY | os.O_DIRECTORY):
                return True
        path = relative(request.get('path'))
        if operation == 'pathExists':
            try:
                self.info(path)
                return True
            except FileNotFoundError:
                return False
        if operation == 'listDir':
            try:
                return self.names(path)
            except FileNotFoundError:
                return []
        if operation == 'readFile':
            return base64.b64encode(self.read(path)).decode('ascii')
        if operation == 'snapshot':
            if type(request.get('includeIgnored')) is not bool:
                reject('includeIgnored must be boolean')
            return self.snapshot(path, request['includeIgnored'])
        if operation == 'mkdirExclusive':
            self.mkdir(path)
        elif operation == 'writeFileAtomic':
            self.write(path, decode(request.get('content')))
        elif operation == 'installSnapshot':
            self.install(path, request.get('entries'))
        elif operation == 'copyWithin':
            self.install(path, self.snapshot(relative(request.get('source')), True))
        elif operation == 'rm':
            self.rm(path)
        else:
            reject('Unsupported filesystem operation')
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--uid', required=True, type=int)
    parser.add_argument('--gid', required=True, type=int)
    args = parser.parse_args()
    filesystem = None
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            reject('Request size limit exceeded')
        request = json.loads(raw)
        filesystem = Filesystem(args.root, args.uid, args.gid)
        response = {'version': 1, 'result': filesystem.execute(request)}
    except Exception as error:
        code = errno.errorcode.get(error.errno, 'EINVAL') if isinstance(error, OSError) else 'EINVAL'
        response = {'version': 1, 'error': {'message': str(error), 'code': code}}
    finally:
        if filesystem is not None:
            os.close(filesystem.root)
    print(json.dumps(response, separators=(',', ':')))


if __name__ == '__main__':
    main()
