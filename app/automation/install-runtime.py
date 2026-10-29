"""Receive and activate an app-owned prebuilt runtime. Never builds on the target Mac."""
import base64
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid

ROOT = pathlib.Path.home() / '.local/share/iphone-mirror/idb'


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def environment():
    if platform.system() != 'Darwin':
        raise RuntimeError('Simulator automation requires a Mac.')
    xcode = subprocess.check_output(['xcodebuild', '-version'], text=True, stderr=subprocess.DEVNULL, timeout=30).strip()
    return {'architecture': platform.machine(), 'macOS': platform.mac_ver()[0], 'xcode': xcode}


def verify(root, bundle):
    if digest(root / 'compatibility.json') != bundle['manifestSha256']:
        raise RuntimeError('Runtime manifest checksum mismatch.')
    manifest = json.loads((root / 'compatibility.json').read_text())
    if manifest.get('bundleId') != bundle['bundleId']:
        raise RuntimeError('Runtime identity mismatch.')
    for name, expected in manifest['files'].items():
        file = root / name
        if file.is_symlink() or digest(file) != expected:
            raise RuntimeError('Runtime file checksum mismatch.')
    for name, expected in manifest['links'].items():
        if not (root / name).is_symlink() or os.readlink(root / name) != expected:
            raise RuntimeError('Runtime link mismatch.')
    return manifest


def extract(archive, destination):
    # Validate each member after previous links exist, including link destinations.
    base = destination.resolve()
    with tarfile.open(archive) as package:
        members = package.getmembers()
        if sum(m.size for m in members) > 1024 * 1024 * 1024 or len(members) > 30000:
            raise RuntimeError('Runtime archive exceeds extraction limits.')
        for member in members:
            target = destination / member.name
            if member.name.startswith('/') or os.path.commonpath([str(base), str(target.resolve())]) != str(base):
                raise RuntimeError('Unsafe runtime archive path.')
            if member.issym() or member.islnk():
                linked = target.parent / member.linkname if member.issym() else destination / member.linkname
                if pathlib.PurePosixPath(member.linkname).is_absolute() or os.path.commonpath([str(base), str(linked.resolve())]) != str(base):
                    raise RuntimeError('Unsafe runtime archive link.')
            elif not (member.isdir() or member.isfile()):
                raise RuntimeError('Unsupported runtime archive entry.')
            package.extract(member, destination)


def health(root):
    env = {k: v for k, v in os.environ.items() if not k.startswith('PYTHON')}
    env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'
    command = [str(root / 'python/bin/python3'), '-I', '-B', str(root / 'python/bin/idb'), '--companion-path', str(root / 'bin/idb_companion'), '--help']
    subprocess.run(command, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    subprocess.run([str(root / 'bin/idb_companion'), '--help'], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def provision(args):
    actual = environment()
    bundle = next((b for b in args['bundles'] if all(b[key] == actual[key] for key in ('architecture', 'macOS', 'xcode'))), None)
    if not bundle:
        return {'ok': False, 'code': 'UNSUPPORTED_RUNTIME', 'message': 'No bundled Simulator runtime matches this Mac, macOS and Xcode.', 'environment': actual}
    if not __import__('re').fullmatch(r'idb-[a-f0-9]{8}-[a-z0-9_]+-[a-f0-9]{16}', bundle['bundleId']):
        raise RuntimeError('Invalid runtime identity.')
    current = ROOT / 'current'
    if args['action'] == 'probe':
        try:
            if current.resolve().parent != ROOT.resolve() or current.resolve().name != bundle['bundleId']:
                raise RuntimeError('Different runtime is active.')
            vmarker = current / '.verified'
            if not (vmarker.exists() and vmarker.read_text().strip() == bundle['manifestSha256']):
                verify(current, bundle)
                vmarker.write_text(bundle['manifestSha256'])
            health(current)
            return {'ok': True, 'ready': True, 'bundleId': bundle['bundleId']}
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            return {'ok': True, 'ready': False, 'bundleId': bundle['bundleId']}
    upload = pathlib.Path(args['upload'])
    if upload.parent.resolve() != ROOT.resolve() or not upload.name.startswith('.upload-') or upload.is_symlink():
        raise RuntimeError('Invalid upload location.')
    if upload.stat().st_size != bundle['archiveBytes'] or digest(upload) != bundle['archiveSha256']:
        upload.unlink(missing_ok=True)
        raise RuntimeError('Runtime archive checksum mismatch.')
    lock_fd = os.open(str(ROOT / 'install.lock'), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another connection is preparing this Mac. Retry when it finishes.')
        try:
            with tempfile.TemporaryDirectory(prefix='.stage-', dir=ROOT) as temporary:
                stage = pathlib.Path(temporary)
                extract(upload, stage)
                verify(stage, bundle)
                health(stage)
                target = ROOT / bundle['bundleId']
                if target.exists():
                    # Preserve an unexpected/damaged prior version for diagnosis.
                    try:
                        verify(target, bundle)
                    except (OSError, ValueError, RuntimeError):
                        target.rename(ROOT / (target.name + '.damaged-' + uuid.uuid4().hex))
                    else:
                        health(target)
                if not target.exists():
                    os.rename(stage, target)
                next_link = ROOT / ('.current-' + uuid.uuid4().hex)
                try:
                    next_link.symlink_to(target.name)
                    os.replace(next_link, current)
                finally:
                    next_link.unlink(missing_ok=True)
                return {'ok': True, 'ready': True, 'installed': True, 'bundleId': bundle['bundleId']}
        finally:
            upload.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        print(json.dumps(provision(json.loads(base64.b64decode(sys.argv[1])))))
    except Exception:
        print(json.dumps({'ok': False, 'code': 'RUNTIME_SETUP_FAILED', 'message': 'Simulator runtime setup failed. The previous active runtime was preserved.'}))
