"""Build and install an arm64 release APK only after checking bundled GLBs."""

import os
import subprocess
import sys
from pathlib import Path
from install_release_apk import connected_devices, install_all


ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
APK = ANDROID / "app/build/outputs/apk/release/app-release.apk"
GRADLE = str(ANDROID / "gradlew.bat")
ABI = "-PreactNativeArchitectures=arm64-v8a"
GENERATED_RAW = ROOT / "android/app/build/generated/res/react/release/raw"

# Load release signing configuration
secrets_file = ROOT / ".play-signing.properties"
if secrets_file.exists():
    for line in secrets_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()


def run(*command, cwd=ROOT):
    print("Running:", " ".join(map(str, command)), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


# Metro does not remove generated resources when a static require is deleted.
# Clear only the generated model/texture files before regenerating the bundle.
if GENERATED_RAW.exists():
    if not GENERATED_RAW.resolve().is_relative_to(ROOT.resolve()):
        raise SystemExit(f"Generated asset path escaped project: {GENERATED_RAW}")
    removed = 0
    for extension in ("*.glb", "*.rgba"):
        for asset in GENERATED_RAW.glob(extension):
            asset.unlink()
            removed += 1
    print(f"Cleared {removed} generated 3D assets before Metro bundling.", flush=True)

# Force the bundle task, then rebuild the APK and compare referenced assets.
run(sys.executable, str(ROOT / "scripts/prepare_runtime_models.py"))
run("node", str(ROOT / "scripts/verify_native_glb.mjs"))
run(GRADLE, ":app:createBundleReleaseJsAndAssets", "--rerun-tasks", ABI, cwd=ANDROID)
run(GRADLE, ":app:assembleRelease", ABI, cwd=ANDROID)
run(sys.executable, str(ROOT / "scripts/verify_release_assets.py"), str(APK))
devices = connected_devices()
if devices:
    if install_all(APK) != 0:
        raise SystemExit("The release APK did not install on every connected device.")
else:
    print(f"Verified release APK built successfully at {APK}.")
    print("No authorized ADB device currently attached; connect phones and run python scripts/install_release_apk.py.")
import shutil
root_apk = ROOT.parent / "ADDA-release.apk"
shutil.copy2(APK, root_apk)
print(f"Copied release APK to {root_apk} ({root_apk.stat().st_size // (1024 * 1024)} MiB)")
