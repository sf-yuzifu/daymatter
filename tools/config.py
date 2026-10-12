"""Single device configuration resolver for build, previews and regression tests."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_devices():
    raw = json.loads((ROOT / "devices.json").read_text(encoding="utf-8"))
    resolved = {}

    def resolve(name, stack=()):
        if name in stack:
            raise ValueError(f"Device inheritance cycle: {stack + (name,)}")
        if name in resolved:
            return resolved[name]
        entry = raw[name]
        parent = entry.get("extends") or entry.get("packageAlias")
        config = dict(resolve(parent, stack + (name,))) if parent else {}
        # Aliases refer to a package, not another alias's relationship.
        config.pop("packageAlias", None)
        config.update({key: value for key, value in entry.items() if key != "extends"})
        if "assets" not in config:
            config["assets"] = name
        resolved[name] = config
        return config

    for name in raw:
        resolve(name)
    return {name: resolved[name] for name in raw}
