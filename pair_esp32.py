#!/usr/bin/env python3
"""
pair_esp32.py
─────────────
Scans for 'ESP32-Basketball' over BLE and pairs / trusts it at the OS level
via bluetoothctl.  Run this once before opening the web app; after that the
browser's getDevices() API will auto-connect without showing the device picker.

Requirements
  pip install bleak        (for scanning)
  bluetoothctl             (ships with bluez on most Linux distros)

Usage
  python3 pair_esp32.py
"""

import asyncio
import subprocess
import sys

DEVICE_NAME  = 'ESP32-Basketball'
SCAN_TIMEOUT = 20   # seconds to wait for advertisement


# ── Step 1: Discover the device ───────────────────────────────────────────────

async def find_device():
    try:
        from bleak import BleakScanner
    except ImportError:
        print("ERROR: 'bleak' is not installed.  Run:  pip install bleak")
        sys.exit(1)

    print(f"Scanning for '{DEVICE_NAME}'…  (up to {SCAN_TIMEOUT} s)")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=SCAN_TIMEOUT)
    return device


# ── Step 2: Pair and trust via bluetoothctl ───────────────────────────────────

def _bluetoothctl(commands: list[str], timeout: int = 15) -> str:
    """Feed a list of commands to bluetoothctl and return combined output."""
    script = '\n'.join(commands) + '\nquit\n'
    result = subprocess.run(
        ['bluetoothctl'],
        input=script,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return (result.stdout + result.stderr).strip()


def pair_and_trust(mac: str) -> bool:
    """Return True if pairing appears successful."""
    print(f"\nPairing {mac} …")
    out = _bluetoothctl([
        'power on',
        f'pair {mac}',
        f'trust {mac}',
    ])
    print(out)
    success = 'Pairing successful' in out or 'AlreadyExists' in out or 'trust succeeded' in out
    return success


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    device = await find_device()

    if device is None:
        print(f"\nERROR: '{DEVICE_NAME}' was not found.")
        print("Make sure the ESP32 is powered on and advertising, then try again.")
        sys.exit(1)

    print(f"\nFound: {device.name}  [{device.address}]  RSSI: {device.rssi} dBm")

    ok = pair_and_trust(device.address)

    if ok:
        print("\n✅  Device paired and trusted.")
        print("Open the web app and click Connect — it will auto-connect without the picker.")
    else:
        print("\n⚠  Pairing result unclear — check the output above.")
        print("If the ESP32 requires a PIN, enter it in the bluetoothctl prompt manually:")
        print(f"  bluetoothctl pair {device.address}")


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
