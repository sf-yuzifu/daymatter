"""Generate clean EasyFace projects from configured assets and optionally compile them."""

import argparse
import json
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from config import load_devices
from metadata import DEFAULT_ID, DEFAULT_VERSION, patch_metadata
from previews import generate

ROOT = Path(__file__).resolve().parents[1]


def lua(value):
    if isinstance(value, dict):
        return "{" + ",".join(f"{key}={lua(item)}" for key, item in value.items()) + "}"
    if isinstance(value, list):
        return "{" + ",".join(map(lua, value)) + "}"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if value is None:
        return "nil"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    devices = load_devices()
    parser.add_argument("--device", choices=["all", *devices], default="all")
    parser.add_argument("--compiler", type=Path, help="Optional EasyFace Compiler.exe")
    parser.add_argument("--id", default=DEFAULT_ID)
    parser.add_argument(
        "--version",
        type=int,
        default=DEFAULT_VERSION,
        help="Watchface release version",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable watchface logs and centered diagnostics",
    )
    args = parser.parse_args()
    suffix = "-debug" if args.debug else ""
    selected = args.device
    if selected != "all":
        selected = devices[selected].get("packageAlias", selected)
    targets = {
        name: config
        for name, config in devices.items()
        if not config.get("packageAlias") and selected in ("all", name)
    }
    # Check every selected asset before removing any generated application content.
    manifests = {name: resource_manifest(config) for name, config in targets.items()}
    generate(targets)
    logic = (ROOT / "src" / "logic.lua").read_text(encoding="utf-8")
    entry = (ROOT / "src" / "daymatter.lua").read_text(encoding="utf-8")
    for name, config in targets.items():
        output = ROOT / "build" / (name + suffix)
        app = output / "app" / "_lua" / "daymatter"
        if (output / "app").exists():
            shutil.rmtree(output / "app")
        app.mkdir(parents=True, exist_ok=True)
        (output / "images").mkdir(exist_ok=True)
        (output / "output").mkdir(exist_ok=True)
        assets = ROOT / "devices" / config.get("assets", name)
        for filename, source_asset in manifests[name].items():
            shutil.copyfile(source_asset, app / filename)
        if config.get("previewSize"):
            # Compiler preview dimensions differ from the runtime display.
            from PIL import Image

            with Image.open(assets / "preview.png") as preview:
                preview.resize(
                    tuple(config["previewSize"]), Image.Resampling.LANCZOS
                ).save(output / "preview.png")
        else:
            shutil.copyfile(assets / "preview.png", output / "preview.png")
        shutil.copyfile(output / "preview.png", output / "images" / "preview.png")
        source = (
            "local DEBUG_ENABLE = "
            + lua(args.debug)
            + "\nlocal LOGIC = (function()\n"
            + logic
            + "\nend)()\nlocal DEVICE = "
            + lua(config)
            + "\n"
            + entry
        )
        (app / "daymatter.lua").write_text(source, encoding="utf-8")
        project = ET.Element("FaceProject", DeviceType=str(config["deviceType"]))
        screen = ET.SubElement(project, "Screen", Title="倒数日", Bitmap="preview.png")
        ET.SubElement(
            screen,
            "Widget",
            Shape="34",
            Name="app__lua%2Fdaymatter%2Fdaymatter.lua",
            X="0",
            Y="0",
            Width=str(config["width"]),
            Height=str(config["height"]),
            Alpha="0",
            Visible_Src="0",
        )
        path = output / "daymatter.fprj"
        ET.ElementTree(project).write(path, encoding="utf-16", xml_declaration=True)
        print(f"{name}: {path}")
        if args.compiler:
            dist = ROOT / "dist"
            dist.mkdir(exist_ok=True)
            artifact = dist / f"daymatter-{name}{suffix}.face"
            staging = output / "compiled"
            staging.mkdir(exist_ok=True)
            fresh = staging / artifact.name
            if fresh.exists():
                fresh.unlink()
            # EasyFace validates this argument as Int32, but leaves the header ID fixed.
            subprocess.run(
                [
                    str(args.compiler.resolve()),
                    "-b",
                    str(path),
                    str(staging),
                    artifact.name,
                    "252661004",
                ],
                check=True,
            )
            if not fresh.is_file():
                raise RuntimeError(f"Compiler did not produce {name} artifact")
            patch_metadata(fresh, args.id, args.version)
            print(f"metadata: ID={args.id}, version={args.version}")
            shutil.copyfile(fresh, artifact)
            for alias, alias_config in devices.items():
                if alias_config.get("packageAlias") == name:
                    shutil.copyfile(artifact, dist / f"daymatter-{alias}{suffix}.face")
                    print(
                        f"{alias}: shared {name} package, compatibility verified on device"
                    )


def resource_manifest(config):
    """Resolve device overrides first, then common assets; only listed files are packed."""
    if not isinstance(config.get("deviceType"), int):
        raise ValueError("deviceType must be a verified integer")
    assets = ROOT / "devices" / config["assets"]
    names = [
        *(f"{digit}.png" for digit in range(10)),
        config.get("beforeImage", "before.png"),
        config.get("laterImage", "later.png"),
        "today.png",
        "mao.png",
    ]
    if config.get("backgroundImage"):
        names.append(config["backgroundImage"])
    manifest = {}
    for name in names:
        if Path(name).name != name or "\\" in name:
            raise ValueError(f"Asset must be a filename: {name}")
        source = assets / name
        if not source.is_file():
            source = ROOT / "assets" / "common" / name
        if not source.is_file():
            raise FileNotFoundError(f"Missing configured asset: {name} ({assets})")
        manifest[name] = source
    return manifest


if __name__ == "__main__":
    main()
