"""Install one verified release APK on every connected, authorized Android device."""

import argparse
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def connected_devices() -> list[str]:
    result = subprocess.run(["adb", "devices"], check=True, capture_output=True, text=True)
    return [parts[0] for line in result.stdout.splitlines()[1:]
            if (parts := line.split()) and len(parts) >= 2 and parts[1] == "device"]


def install(apk: Path, serial: str) -> tuple[str, bool, str]:
    result = subprocess.run(["adb", "-s", serial, "install", "-r", str(apk)], capture_output=True, text=True)
    return serial, result.returncode == 0, (result.stdout + result.stderr).strip()


def install_all(apk: Path) -> int:
    if not apk.is_file():
        raise SystemExit(f"APK not found: {apk}")
    devices = connected_devices()
    if not devices:
        print("No authorized Android devices connected. Connect and unlock the phones, then rerun this script.")
        return 1
    print(f"Installing {apk.name} on {len(devices)} device(s) concurrently.", flush=True)
    with ThreadPoolExecutor(max_workers=len(devices)) as workers:
        results = list(workers.map(lambda serial: install(apk, serial), devices))
    for serial, success, output in results:
        print(f"{serial}: {'installed' if success else 'FAILED'}\n{output}", flush=True)
    return 0 if all(success for _, success, _ in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[2] / "ADDA-release.apk")
    args = parser.parse_args()
    raise SystemExit(install_all(args.apk.resolve()))
