"""Import original assets, generate EasyFace projects and optionally compile them."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET

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
    return str(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=["all", "band9", "band10", "band9pro", "s4"], default="all")
    parser.add_argument("--import-assets", action="store_true", help="Import and preserve branch binary assets once")
    parser.add_argument("--band10-device-type", type=int, help="Verified EasyFace Band 10 DeviceType")
    parser.add_argument("--compiler", type=Path, help="Optional EasyFace Compiler.exe")
    parser.add_argument("--id", type=int, default=252661004)
    args = parser.parse_args()
    devices = json.loads((ROOT / "devices.json").read_text(encoding="utf-8"))
    if args.import_assets:
        for name, config in devices.items():
            destination = ROOT / "devices" / name
            destination.mkdir(parents=True, exist_ok=True)
            paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", config["branch"]], cwd=ROOT).decode().splitlines()
            for path in paths:
                if path == "app/_lua/daymatter/bg.bin" or path == "preview.png":
                    data = subprocess.check_output(["git", "show", f'{config["branch"]}:{path}'], cwd=ROOT)
                    output = destination / Path(path).name
                    if output.exists() and output.read_bytes() != data:
                        raise RuntimeError(f"Refusing to overwrite modified asset: {output}")
                    output.write_bytes(data)
    logic = (ROOT / "src" / "logic.lua").read_text(encoding="utf-8")
    entry = (ROOT / "src" / "daymatter.lua").read_text(encoding="utf-8")
    for name, config in devices.items():
        if args.device not in ("all", name):
            continue
        config = dict(config)
        if name == "band10" and args.band10_device_type is not None:
            config["deviceType"] = args.band10_device_type
        output = ROOT / "build" / name
        app = output / "app" / "_lua" / "daymatter"
        app.mkdir(parents=True, exist_ok=True)
        (output / "images").mkdir(exist_ok=True)
        (output / "output").mkdir(exist_ok=True)
        assets = ROOT / "devices" / name
        shutil.copyfile(assets / "bg.bin", app / "bg.bin")
        for filename in [*(f"{digit}.png" for digit in range(10)), "before.png", "later.png", "today.png", "mao.png"]:
            shutil.copyfile(ROOT / "png" / filename, app / filename)
            obsolete = app / (Path(filename).stem + ".bin")
            if obsolete.exists():
                obsolete.unlink()
        shutil.copyfile(assets / "preview.png", output / "preview.png")
        shutil.copyfile(assets / "preview.png", output / "images" / "preview.png")
        source = "local LOGIC = (function()\n" + logic + "\nend)()\nlocal DEVICE = " + lua(config) + "\n" + entry
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
            subprocess.run([str(args.compiler.resolve()), "-b", str(path), str(dist), f"daymatter-{name}.face", str(args.id)], check=True)
            if not (dist / f"daymatter-{name}.face").is_file():
                raise RuntimeError(f"Compiler did not produce {name} artifact")


if __name__ == "__main__":
    main()
