"""Verify stale-resource removal and selected-device preview isolation."""
import os
from pathlib import Path
import subprocess
import sys
from config import load_devices
from build import resource_manifest

ROOT = Path(__file__).resolve().parents[1]
devices = load_devices()
previews = list((ROOT / "devices").glob("*/preview.png"))
original_times = {path: path.stat().st_mtime_ns for path in previews}
app = ROOT / "build/band10/app/_lua/daymatter"
app.mkdir(parents=True, exist_ok=True)
(app / "obsolete.bin").write_bytes(b"obsolete")
nested = app / "old-module"
nested.mkdir(exist_ok=True)
(nested / "old.lua").write_text("old", encoding="utf-8")
try:
    subprocess.run([sys.executable, str(ROOT / "tools/build.py"), "--device", "band11"], check=True)
    expected = {*resource_manifest(devices["band10"]), "daymatter.lua"}
    actual = {str(path.relative_to(app)) for path in app.rglob("*") if path.is_file()}
    assert actual == expected, (actual, expected)
    for path, timestamp in original_times.items():
        if path.parent.name != "band10":
            assert path.stat().st_mtime_ns == timestamp, f"Unselected preview changed: {path}"
    # Missing resources must fail before cleaning existing generated files.
    config = dict(devices["band10"], backgroundImage="missing-resource.png")
    try:
        resource_manifest(config)
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("Missing asset was accepted")
    print("Clean resource manifest, alias selection and preview isolation passed")
finally:
    for path, timestamp in original_times.items():
        os.utime(path, ns=(path.stat().st_atime_ns, timestamp))
