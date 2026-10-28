"""Build a relocatable IDB runtime after ./build.sh build idb_companion on a Mac."""
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

PIN = '1387b360a9dcad34573cb1d9f277e5a0eacfd804'
PYTHON_SHA256 = '2fd8becd48cf0ff5f0a15df3c0db7cae7aa708dcaacf901bd30d6cdd6229370b'


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def build(source, python_archive, output, requirements):
    assert platform.system() == 'Darwin' and platform.machine() == 'x86_64', 'Qualify other architectures separately'
    assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    assert digest(python_archive) == PYTHON_SHA256, 'Portable Python checksum mismatch'
    companion = source / 'Build/Products/Release/idb_companion'
    assert companion.is_file(), 'Build the pinned native companion first'
    output.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'FB_IDB_VERSION': '1.1.8', 'PYTHONDONTWRITEBYTECODE': '1'}
    with tempfile.TemporaryDirectory(prefix='idb-runtime-build-') as temporary:
        work = pathlib.Path(temporary)
        root = work / 'runtime'
        root.mkdir()
        with tarfile.open(python_archive) as archive:
            archive.extractall(root, filter='data')
        python = root / 'python/bin/python3'
        run = lambda args: subprocess.run(list(map(str, args)), check=True, env=env)
        run([python, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--only-binary=:all:', '-r', requirements])
        build_env = work / 'build-env'
        run([python, '-m', 'venv', '--system-site-packages', build_env])
        build_python = build_env / 'bin/python'
        run([build_python, '-m', 'pip', 'install', 'setuptools==84.2.1', 'wheel==0.48.0', 'grpcio-tools==1.85.0'])
        run([build_python, '-m', 'pip', 'wheel', '--no-build-isolation', '--no-deps', '--wheel-dir', work / 'wheels', source])
        wheel = next((work / 'wheels').glob('fb_idb-*.whl'))
        run([python, '-m', 'pip', 'install', '--no-deps', '--no-compile', '--no-index', wheel])
        (root / 'bin').mkdir()
        shutil.copy2(companion, root / 'bin/idb_companion')
        for resource in companion.parent.glob('*.bundle'):
            shutil.copytree(resource, root / 'bin' / resource.name)
        shutil.copy2(source / 'LICENSE', root / 'IDB-LICENSE')
        # The CLI is invoked with this interpreter, never its build-directory shebang.
        run([python, '-I', '-B', root / 'python/bin/idb', '--companion-path', root / 'bin/idb_companion', '--help'])
        for cache in sorted(root.rglob('__pycache__'), reverse=True):
            shutil.rmtree(cache)
        manifest = {
            'layoutVersion': 2, 'commit': PIN, 'architecture': platform.machine(),
            'macOS': platform.mac_ver()[0],
            'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
            'pythonVersion': subprocess.check_output([python, '-I', '-B', '--version'], text=True).strip(),
            'pythonArchiveSha256': PYTHON_SHA256,
            'companionSha256': digest(root / 'bin/idb_companion'),
            'sourcePatchSha256': hashlib.sha256(subprocess.check_output(['git', '-C', str(source), 'diff', '--binary'])).hexdigest(),
            'files': {}, 'links': {}
        }
        for file in sorted(root.rglob('*')):
            relative = file.relative_to(root).as_posix()
            if file.is_symlink():
                manifest['links'][relative] = os.readlink(file)
            elif file.is_file():
                manifest['files'][relative] = digest(file)
        identity = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
        manifest['bundleId'] = 'idb-' + PIN[:8] + '-x86_64-' + identity
        (root / 'compatibility.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        with tarfile.open(output, 'w:gz') as archive:
            archive.add(root, arcname='.')
        catalog = {key: manifest[key] for key in ('bundleId', 'commit', 'architecture', 'macOS', 'xcode', 'pythonVersion', 'companionSha256')}
        catalog.update({'archive': output.name, 'archiveBytes': output.stat().st_size, 'archiveSha256': digest(output), 'manifestSha256': digest(root / 'compatibility.json')})
        output.with_suffix('.json').write_text(json.dumps(catalog, indent=2) + '\n')
        print('RUNTIME_BUNDLE=' + json.dumps(catalog))


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('Usage: build-runtime.py IDB_SOURCE PORTABLE_PYTHON_TAR OUTPUT_TAR REQUIREMENTS_LOCK')
    build(*(pathlib.Path(value).resolve() for value in sys.argv[1:]))
