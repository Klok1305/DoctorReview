from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources"
SIZE = 1024


def build_icon() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((48, 48, 976, 976), radius=220, fill=255)

    gradient = Image.new("RGBA", (SIZE, SIZE))
    pixels = gradient.load()
    top = (37, 99, 235)
    bottom = (29, 78, 216)
    for y in range(SIZE):
        ratio = y / (SIZE - 1)
        color = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3)) + (255,)
        for x in range(SIZE):
            pixels[x, y] = color
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", image.size), mask))

    draw = ImageDraw.Draw(image)
    white = (255, 255, 255, 255)
    draw.rounded_rectangle((190, 421, 834, 603), radius=54, fill=white)
    draw.rounded_rectangle((421, 190, 603, 834), radius=54, fill=white)

    cyan = (103, 232, 249, 255)
    points = [(235, 686), (395, 548), (525, 628), (753, 374)]
    draw.line(points, fill=cyan, width=66, joint="curve")
    draw.polygon([(753, 374), (655, 401), (732, 469), (831, 286)], fill=cyan)
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(OUT / "app-icon.png", optimize=True)
    icon.save(
        OUT / "app-icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
