"""Append Quaternius sitting clips to the already bundled boy/girl GLBs.

The characters and UAL1 share node order and bone names. The source clips are
authored animations, including entry, idle and exit; no runtime pose is faked.
This script is idempotent so it can be rerun without expanding the assets.
"""

import copy
import json
import struct
from pathlib import Path


CLIPS = {
    "Sitting_Enter": "sit_enter",
    "Sitting_Idle_Loop": "sit_idle",
    "Sitting_Exit": "sit_exit",
}


def read_glb(path: Path):
    data = path.read_bytes()
    assert data[:4] == b"glTF"
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + json_length])
    binary_length = struct.unpack_from("<I", data, 20 + json_length)[0]
    binary = data[28 + json_length : 28 + json_length + binary_length]
    return document, binary


def write_glb(path: Path, document: dict, binary: bytearray):
    while len(binary) % 4:
        binary.append(0)
    document["buffers"][0]["byteLength"] = len(binary)
    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    output = bytearray(b"glTF")
    output.extend(struct.pack("<II", 2, 20 + len(encoded) + 8 + len(binary)))
    output.extend(struct.pack("<I4s", len(encoded), b"JSON"))
    output.extend(encoded)
    output.extend(struct.pack("<I4s", len(binary), b"BIN\0"))
    output.extend(binary)
    path.write_bytes(output)


def append_clips(character_path: Path, source_document: dict, source_binary: bytes):
    document, original_binary = read_glb(character_path)
    existing = {animation.get("name") for animation in document.get("animations", [])}
    missing = {source: target for source, target in CLIPS.items() if target not in existing}
    if not missing:
        print(f"{character_path.name}: sitting clips already present")
        return

    assert [node.get("name") for node in document["nodes"][:65]] == [
        node.get("name") for node in source_document["nodes"][:65]
    ], "The character and animation rigs differ"

    binary = bytearray(original_binary)
    view_map = {}
    accessor_map = {}

    def copy_accessor(index: int):
        if index in accessor_map:
            return accessor_map[index]
        accessor = copy.deepcopy(source_document["accessors"][index])
        old_view_index = accessor["bufferView"]
        if old_view_index not in view_map:
            old_view = source_document["bufferViews"][old_view_index]
            start = old_view.get("byteOffset", 0)
            while len(binary) % 4:
                binary.append(0)
            new_view = copy.deepcopy(old_view)
            new_view["byteOffset"] = len(binary)
            new_view["buffer"] = 0
            binary.extend(source_binary[start : start + old_view["byteLength"]])
            view_map[old_view_index] = len(document["bufferViews"])
            document["bufferViews"].append(new_view)
        accessor["bufferView"] = view_map[old_view_index]
        accessor_map[index] = len(document["accessors"])
        document["accessors"].append(accessor)
        return accessor_map[index]

    source_animations = {animation["name"]: animation for animation in source_document["animations"]}
    for source_name, target_name in missing.items():
        animation = copy.deepcopy(source_animations[source_name])
        animation["name"] = target_name
        for sampler in animation["samplers"]:
            sampler["input"] = copy_accessor(sampler["input"])
            sampler["output"] = copy_accessor(sampler["output"])
        document["animations"].append(animation)

    write_glb(character_path, document, binary)
    print(f"{character_path.name}: added {', '.join(missing.values())}")


def main():
    models = Path(__file__).resolve().parent.parent / "assets" / "models"
    source_document, source_binary = read_glb(models / "ual1.glb")
    for name in ("boy", "girl"):
        append_clips(models / f"{name}.glb", source_document, source_binary)


if __name__ == "__main__":
    main()
