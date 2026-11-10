# /// script
# requires-python = ">=3.12"
# dependencies = ["pymobiledevice3==11.50.3"]
# ///
import pathlib
import runpy
runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1]/'app'/'drivers'/'usb-phone.py'),run_name=__name__)
