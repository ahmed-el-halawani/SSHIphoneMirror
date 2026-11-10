# /// script
# requires-python = ">=3.12"
# dependencies = ["pymobiledevice3==11.50.3"]
# ///
"""Discover and verify USB iPhones for the remote Mac bridge.

Run with `uv run --script scripts/usb-phone.py --check`. The Node bridge
supervisor owns reconnection and the SSH transport to the Mac.
"""

import argparse
import asyncio
import json
import pathlib
import re
import sys


def choose_device(devices, selected=None):
    serials = sorted({device.serial for device in devices if device.is_usb})
    if selected:
        return selected if selected in serials else None
    if len(serials) > 1:
        raise ValueError("Multiple USB iPhones found. Use --udid to select one.")
    return serials[0] if serials else None


def require_supported(info):
    if info.get("ProductType", "").startswith("iPhone") is False:
        raise ValueError("The USB bridge currently supports iPhones only.")
    try:
        major = int(info["ProductVersion"].split(".")[0])
    except (KeyError, ValueError, AttributeError):
        raise ValueError("Could not determine the iPhone's iOS version.") from None
    if major < 17:
        raise ValueError("The CoreDevice bridge needs iOS 17 or later.")


def emit(state, **fields):
    print(json.dumps({"state": state, **fields}), flush=True)


async def scan():
    from pymobiledevice3.usbmux import list_devices

    return await asyncio.wait_for(list_devices(), 10)


async def bridge_info(selected=None):
    from dataclasses import asdict
    from pymobiledevice3.bonjour import browse_remotepairing, browse_mobdev2
    from pymobiledevice3.lockdown import create_using_tcp, create_using_usbmux
    from pymobiledevice3.exceptions import PyMobileDevice3Exception

    udid = choose_device(await scan(), selected)
    if not udid:
        raise RuntimeError("No selected USB iPhone is connected.")
    if not re.fullmatch(r'(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{16}|[0-9a-fA-F]{40})', udid):
        raise ValueError("Invalid USB device identifier.")
    cache = pathlib.Path.home()/'.iphone-mirror'/'usb-bridge'/(udid+'.json')
    cached = {}
    try:
        cached = json.loads(cache.read_text())
    except (OSError, ValueError):
        pass
    if not isinstance(cached, dict) or cached.get('udid') != udid:
        cached = {}
    lockdown = await create_using_usbmux(serial=udid, connection_type="USB", pair_timeout=30)
    try:
        require_supported(lockdown.all_values)
        name = lockdown.all_values.get("DeviceName", "iPhone")
        pair_record = lockdown.pair_record
    finally:
        await lockdown.close()
    records = [asdict(item) for item in await browse_remotepairing(timeout=3)]
    if cached.get('udid') == udid and isinstance(cached.get('record'), dict):
        records.append(cached['record'])
    for record in records:
        for address in record['addresses']:
            # The proof bridge uses the USB Ethernet endpoint, never a LAN/Wi-Fi phone.
            import ipaddress
            ip = ipaddress.ip_address(address['ip'])
            if ip.version != 4 or not (ip.is_link_local or address['ip'] == "172.20.10.1"):
                continue
            try:
                peer = await asyncio.wait_for(create_using_tcp(address['ip'], pair_record=pair_record, pair_timeout=0), 4)
                try:
                    if await peer.get_value(key="UniqueDeviceID") == udid:
                        mobile = [asdict(item) for item in await browse_mobdev2(timeout=3)
                                  if any(candidate.ip == address['ip'] for candidate in item.addresses)]
                        info = {"udid": udid, "name": name, "address": address['ip'], "record": record,
                                "mobile": mobile or cached.get('mobile', [])}
                        try:
                            cache.parent.mkdir(parents=True, exist_ok=True)
                            cache.write_text(json.dumps(info))
                            cache.chmod(0o600)
                        except OSError:
                            print('Could not cache USB discovery metadata; sleep reconnection may need the phone unlocked.', file=sys.stderr)
                        return info
                finally:
                    await peer.close()
            except (OSError, asyncio.TimeoutError, PyMobileDevice3Exception):
                continue
    raise RuntimeError("No verified USB Ethernet developer endpoint found. This bridge prototype needs the iPhone's Apple USB Ethernet adapter; it does not substitute another network device.")


async def main(args):
    if args.bridge_info:
        print(json.dumps(await bridge_info(args.udid)), flush=True)
    else:
        devices = await scan()
        emit("devices", devices=[device.serial for device in devices if device.is_usb])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="List USB devices once without pairing or starting a viewer.")
    parser.add_argument("--udid", help="Choose a specific phone when more than one is connected.")
    parser.add_argument("--bridge-info", action="store_true", help="Find and verify the selected USB phone's developer endpoint.")
    try:
        asyncio.run(main(parser.parse_args()))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        emit("error", message=f"{type(error).__name__}: {error}")
        sys.exit(1)
