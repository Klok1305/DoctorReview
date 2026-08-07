from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources"
SIZE = 1024


def cubic_points(start, control_1, control_2, end, steps=48):
    points = []
    for index in range(steps + 1):
        t = index / steps
        inverse = 1 - t
        x = (
            inverse**3 * start[0]
            + 3 * inverse**2 * t * control_1[0]
            + 3 * inverse * t**2 * control_2[0]
            + t**3 * end[0]
        )
        y = (
            inverse**3 * start[1]
            + 3 * inverse**2 * t * control_1[1]
            + 3 * inverse * t**2 * control_2[1]
            + t**3 * end[1]
        )
        points.append((round(x), round(y)))
    return points


def build_icon() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((48, 48, 976, 976), radius=220, fill=255)

    gradient = Image.new("RGBA", (SIZE, SIZE))
    pixels = gradient.load()
    top = (37, 99, 235)
    bottom = (18, 59, 135)
    for y in range(SIZE):
        ratio = y / (SIZE - 1)
        color = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3)) + (255,)
        for x in range(SIZE):
            pixels[x, y] = color
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", image.size), mask))

    draw = ImageDraw.Draw(image)
    white = (255, 255, 255, 255)
    heart = []
    heart += cubic_points((512, 800), (430, 735), (205, 585), (205, 380))[:-1]
    heart += cubic_points((205, 380), (205, 220), (400, 190), (512, 340))[:-1]
    heart += cubic_points((512, 340), (624, 190), (819, 220), (819, 380))[:-1]
    heart += cubic_points((819, 380), (819, 585), (594, 735), (512, 800))
    draw.line(heart, fill=white, width=68, joint="curve")

    mint = (94, 234, 212, 255)
    vector = [(270, 630), (420, 500), (535, 575), (748, 330)]
    draw.line(vector, fill=mint, width=58, joint="curve")
    draw.polygon([(748, 330), (649, 354), (726, 430), (842, 230)], fill=mint)
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
