import importlib.util
import hashlib
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import types
import unittest
sys.dont_write_bytecode = True
if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).parents[1]/'app/automation/install-runtime.py')
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class RuntimeTests(unittest.TestCase):
    def test_archive_paths_and_links_cannot_escape_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            for name,link in [('../escape',''),('/absolute',''),('link','../../escape')]:
                archive=root/'test.tar'
                with tarfile.open(archive,'w') as package:
                    item=tarfile.TarInfo(name)
                    if link:
                        item.type=tarfile.SYMTYPE;item.linkname=link
                        package.addfile(item)
                    else:
                        item.size=1;package.addfile(item,io.BytesIO(b'x'))
                destination=root/'stage';destination.mkdir(exist_ok=True)
                with self.assertRaisesRegex(RuntimeError,'Unsafe'):
                    installer.extract(archive,destination)
                self.assertFalse((root/'escape').exists())

    def test_manifest_and_every_payload_file_are_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);(root/'payload').write_bytes(b'expected')
            manifest={'bundleId':'test','files':{'payload':hashlib.sha256(b'expected').hexdigest()},'links':{}}
            (root/'compatibility.json').write_text(json.dumps(manifest))
            bundle={'bundleId':'test','manifestSha256':installer.digest(root/'compatibility.json')}
            installer.verify(root,bundle)
            (root/'payload').write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError,'file checksum'):
                installer.verify(root,bundle)


unittest.main()
