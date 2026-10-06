"""Render the captured offline demo. Optional dependency: Pillow 11.3.0."""
from pathlib import Path
import re
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
assets = root / "docs/assets"
text = (assets / "terminal-demo.txt").read_text()
panels = re.split(r"\n\n(?=\[\d/4\])", text.strip())
assert len(panels) == 4, "Capture all four demo steps first"
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 20)
title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 23)
frames = []
for index, panel in enumerate(panels):
    canvas = Image.new("RGB", (1120, 570), "#0b1218")
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((20, 20, 1100, 550), radius=18, fill="#111e27", outline="#29414b", width=2)
    draw.text((48, 42), "HERMES x ZOUROBOROS", font=title, fill="#f3eee4")
    draw.text((48, 83), "Local memory. Reviewable work. Your VPS.", font=font, fill="#e9b76b")
    draw.line((48, 124, 1072, 124), fill="#29414b", width=2)
    for line_number, line in enumerate(panel.splitlines()):
        y = 148 + line_number * 29
        assert y + 25 < 501 and draw.textlength(line, font=font) < 1024, "Demo text overflows"
        color = "#42dec5" if line.startswith(("[", "$", "MCP", "  PASS")) else "#f3eee4"
        draw.text((48, y), line, font=font, fill=color)
    draw.text((48, 513), "Recorded local calls | Condensed output | No provider calls", font=font, fill="#9aafb8")
    for dot in range(4):
        x = 989 + dot * 23
        draw.ellipse((x, 520, x + 9, 529), fill="#42dec5" if dot == index else "#29414b")
    frames.append(canvas)
frames[0].save(assets / "terminal-demo.gif", save_all=True, append_images=frames[1:],
               duration=[6000, 5000, 5000, 8000], loop=0, optimize=True)
print("Rendered four frames, 24 seconds: docs/assets/terminal-demo.gif")
