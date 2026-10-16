"""Fail if an Android release APK contains stale bundled 3D models.

Metro copies required GLBs into APK resources under shortened names, so we
compare their SHA-256 hashes with the source files rather than their names.
"""

import hashlib
import re
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APK = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "android/app/build/outputs/apk/release/app-release.apk"

source_text = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "src").rglob("*.ts*"))
models = sorted(set(re.findall(r"assets/runtime_models/([A-Za-z0-9_.-]+\.glb)", source_text)))
textures = sorted(set(re.findall(r"assets/textures/([A-Za-z0-9_.-]+\.rgba)", source_text)))
if not models or not textures:
    raise SystemExit("No referenced GLB assets found; cannot verify release APK")

with zipfile.ZipFile(APK) as apk:
    bundled_hashes = {
        extension: {
            hashlib.sha256(apk.read(entry)).hexdigest()
            for entry in apk.namelist()
            if entry.endswith(extension)
        }
        for extension in (".glb", ".rgba")
    }

stale = []
for folder, names, extension in (("runtime_models", models, ".glb"), ("textures", textures, ".rgba")):
    required_hashes = set()
    for name in names:
        source = ROOT / "assets" / folder / name
        if not source.is_file():
            raise SystemExit(f"Referenced asset is missing: {source}")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        required_hashes.add(digest)
        if digest not in bundled_hashes[extension]:
            stale.append(name)
        else:
            print(f"MATCH {name} {digest[:12]}")
    extras = bundled_hashes[extension] - required_hashes
    if extras:
        raise SystemExit(f"APK contains {len(extras)} unreferenced {extension} assets")

if stale:
    raise SystemExit(f"APK contains stale or missing GLBs: {', '.join(stale)}")
print(f"Verified {len(models)} GLBs and {len(textures)} texture packs in {APK}")
