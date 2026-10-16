"""Build smaller app-only GLBs while retaining source models and full texture packs.

The React Native loader supplies every image from assets/textures/*.rgba. Embedded
JPEG/PNG payloads in the GLBs are duplicate data in the APK. Replace each with a
valid one-pixel image while preserving image indices, geometry, skins, and clips.
"""

import json
import re
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/models"
OUTPUT = ROOT / "assets/runtime_models"


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))


PLACEHOLDER = (b"\x89PNG\r\n\x1a\n" +
               png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) +
               png_chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff")) +
               png_chunk(b"IEND", b""))


def prepare(source: Path, target: Path) -> None:
    raw = source.read_bytes()
    if raw[:4] != b"glTF" or struct.unpack_from("<I", raw, 4)[0] != 2:
        raise ValueError(f"Expected GLB v2: {source}")
    json_length, json_type = struct.unpack_from("<I4s", raw, 12)
    if json_type != b"JSON":
        raise ValueError(f"Missing JSON chunk: {source}")
    document = json.loads(raw[20:20 + json_length])
    binary_header = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<I4s", raw, binary_header)
    if binary_type != b"BIN\0" or len(document["buffers"]) != 1:
        raise ValueError(f"Expected one binary buffer: {source}")
    binary = raw[binary_header + 8:binary_header + 8 + binary_length]
    images = {image["bufferView"]: PLACEHOLDER
              for image in document.get("images", []) if "bufferView" in image}
    if len(images) != len(document.get("images", [])):
        raise ValueError(f"Image uses unsupported URI or shared buffer view: {source}")
    for image in document.get("images", []):
        image["mimeType"] = "image/png"
    result = bytearray()
    for index, view in enumerate(document["bufferViews"]):
        result.extend(b"\0" * (-len(result) % 4))
        start = view.get("byteOffset", 0)
        payload = images.get(index, binary[start:start + view["byteLength"]])
        view["byteOffset"] = len(result)
        view["byteLength"] = len(payload)
        result.extend(payload)
    document["buffers"][0]["byteLength"] = len(result)
    result.extend(b"\0" * (-len(result) % 4))
    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    built = (struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(result)) +
             struct.pack("<I4s", len(encoded), b"JSON") + encoded +
             struct.pack("<I4s", len(result), b"BIN\0") + result)
    target.write_bytes(built)
    print(f"{source.name}: {len(raw) // 1024} KiB -> {len(built) // 1024} KiB")


def main() -> None:
    source_text = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "src").rglob("*.ts*"))
    names = sorted(set(re.findall(r"assets/runtime_models/([A-Za-z0-9_.-]+\.glb)", source_text)))
    if not names:
        raise SystemExit("No runtime GLB imports were found")
    OUTPUT.mkdir(exist_ok=True)
    for name in names:
        prepare(SOURCE / name, OUTPUT / name)


if __name__ == "__main__":
    main()
