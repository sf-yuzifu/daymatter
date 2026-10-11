"""Centered cover crop with antialiased device screen masks."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SCREENS = {
    "band9": (192, 490, "capsule"), "band10": (212, 520, "capsule"),
    "band9pro": (336, 480, 48), "redmiwatch6": (432, 514, 104),
    "s4": (466, 466, "circle"), "s5_46": (480, 480, "circle"),
}


def generate():
    with Image.open(ROOT / "assets" / "preview-base.png") as original:
        base = original.convert("RGBA")
    for name, (width, height, shape) in SCREENS.items():
        image = ImageOps.fit(base, (width, height), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        factor = 4
        mask = Image.new("L", (width * factor, height * factor), 0)
        draw = ImageDraw.Draw(mask)
        bounds = (0, 0, width * factor - 1, height * factor - 1)
        if shape == "circle":
            draw.ellipse(bounds, fill=255)
        else:
            radius = width / 2 if shape == "capsule" else shape
            draw.rounded_rectangle(bounds, radius=round(radius * factor), fill=255)
        mask = mask.resize((width, height), Image.Resampling.LANCZOS)
        image.putalpha(mask)
        destination = ROOT / "devices" / name / "preview.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination)
        print(f"{name}: {width}x{height}, {shape}")


if __name__ == "__main__":
    generate()
