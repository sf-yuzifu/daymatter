"""Import original assets, generate EasyFace projects and optionally compile them."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET
from previews import generate
from config import load_devices

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
    parser.add_argument("--band10-device-type", type=int, help="Verified EasyFace Band 10 DeviceType")
    parser.add_argument("--compiler", type=Path, help="Optional EasyFace Compiler.exe")
    parser.add_argument("--id", type=int, default=252661004)
    parser.add_argument("--debug", action="store_true", help="Enable watchface logs and centered diagnostics")
    args = parser.parse_args()
    suffix = "-debug" if args.debug else ""
    generate(devices)
    selected = args.device
    if selected != "all":
        selected = devices[selected].get("packageAlias", selected)
    logic = (ROOT / "src" / "logic.lua").read_text(encoding="utf-8")
    entry = (ROOT / "src" / "daymatter.lua").read_text(encoding="utf-8")
    for name, config in devices.items():
        if config.get("packageAlias") or selected not in ("all", name):
            continue
        config = dict(config)
        if name == "band10" and args.band10_device_type is not None:
            config["deviceType"] = args.band10_device_type
        output = ROOT / "build" / (name + suffix)
        app = output / "app" / "_lua" / "daymatter"
        app.mkdir(parents=True, exist_ok=True)
        (output / "images").mkdir(exist_ok=True)
        (output / "output").mkdir(exist_ok=True)
        assets = ROOT / "devices" / config.get("assets", name)
        if config.get("backgroundImage"):
            shutil.copyfile(assets / config["backgroundImage"], app / config["backgroundImage"])
        if (app / "bg.bin").exists():
            (app / "bg.bin").unlink()
        for filename in [*(f"{digit}.png" for digit in range(10)), config.get("beforeImage", "before.png"), config.get("laterImage", "later.png"), "today.png", "mao.png"]:
            source_asset = assets / filename if filename.endswith("_9.png") else ROOT / "assets" / "common" / filename
            shutil.copyfile(source_asset, app / filename)
            obsolete = app / (Path(filename).stem + ".bin")
            if obsolete.exists():
                obsolete.unlink()
        if name == "band9":
            for filename in ("before.png", "later.png"):
                if (app / filename).exists():
                    (app / filename).unlink()
        if config.get("previewSize"):
            # Compiler preview dimensions differ from the runtime display.
            from PIL import Image
            with Image.open(assets / "preview.png") as preview:
                preview.resize(tuple(config["previewSize"]), Image.Resampling.LANCZOS).save(output / "preview.png")
        else:
            shutil.copyfile(assets / "preview.png", output / "preview.png")
        shutil.copyfile(output / "preview.png", output / "images" / "preview.png")
        source = "local DEBUG_ENABLE = " + lua(args.debug) + "\nlocal LOGIC = (function()\n" + logic + "\nend)()\nlocal DEVICE = " + lua(config) + "\n" + entry
        (app / "daymatter.lua").write_text(source, encoding="utf-8")
        if config["deviceType"] is None:
            print(f"{name}: Lua/assets generated; .fprj blocked until --band10-device-type is verified")
            stale = output / "daymatter.fprj"
            if stale.exists():
                stale.unlink()
            continue
        project = ET.Element("FaceProject", DeviceType=str(config["deviceType"]))
        screen = ET.SubElement(project, "Screen", Title="倒数日", Bitmap="preview.png")
        ET.SubElement(screen, "Widget", Shape="34", Name="app__lua%2Fdaymatter%2Fdaymatter.lua", X="0", Y="0",
                      Width=str(config["width"]), Height=str(config["height"]), Alpha="0", Visible_Src="0")
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
            subprocess.run([str(args.compiler.resolve()), "-b", str(path), str(staging), artifact.name, str(args.id)], check=True)
            if not fresh.is_file():
                raise RuntimeError(f"Compiler did not produce {name} artifact")
            shutil.copyfile(fresh, artifact)
            for alias, alias_config in devices.items():
                if alias_config.get("packageAlias") == name:
                    shutil.copyfile(artifact, dist / f"daymatter-{alias}{suffix}.face")
                    print(f"{alias}: shared {name} package, compatibility verified on device")


if __name__ == "__main__":
    main()
