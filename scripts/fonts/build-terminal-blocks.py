"""
Builds src/renderer/src/assets/cr-terminal-blocks.ttf: block elements
(U+2580–259F) and box drawing (U+2500–257F), drawn to fill the whole
terminal cell and a hair beyond, on Menlo's grid (advance 1233 / 2048).

Why: the terminal uses xterm's DOM renderer (WebGL crashed this Mac's GPU
process), which draws these characters from the font — and Menlo's own
full block covers only ~88% of its line height, so Claude Code's banner and
box outlines came apart in rows. The app lists this font first for those
code points only (unicode-range), so everything else is still Menlo.

Run with fontTools installed:  python3 scripts/fonts/build-terminal-blocks.py
"""

import math
import unicodedata
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 2048
ADV = 1233  # Menlo's advance width
ASC = 1901  # Menlo's hhea ascent
DESC = -483  # Menlo's hhea descent
OV = 36  # overshoot past the cell on every side, so neighbours overlap
X0, X1 = -OV, ADV + OV
Y0, Y1 = DESC - OV, ASC + OV
CX = ADV / 2
CY = (DESC + ASC) / 2
W = {"light": 150, "heavy": 300}
DOUBLE_STROKE = 110
DOUBLE_GAP = 110


def rect(pen, x0, y0, x1, y1):
    x0, y0, x1, y1 = (round(v) for v in (x0, y0, x1, y1))
    if x1 <= x0 or y1 <= y0:
        return
    # Clockwise, as TrueType outlines expect.
    pen.moveTo((x0, y0))
    pen.lineTo((x0, y1))
    pen.lineTo((x1, y1))
    pen.lineTo((x1, y0))
    pen.closePath()


def poly(pen, points):
    pts = [(round(x), round(y)) for x, y in points]
    # Make it clockwise (negative signed area in y-up coordinates).
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
               for i in range(len(pts)))
    if area > 0:
        pts.reverse()
    pen.moveTo(pts[0])
    for p in pts[1:]:
        pen.lineTo(p)
    pen.closePath()


def fx(f):
    """Cell x at fraction f (0 left .. 1 right), stretched to the overshoot at the edges."""
    return X0 if f <= 0 else X1 if f >= 1 else f * ADV


def fy(f):
    """Cell y at fraction f (0 bottom .. 1 top)."""
    return Y0 if f <= 0 else Y1 if f >= 1 else DESC + f * (ASC - DESC)


# ---- Block elements -------------------------------------------------------

def blocks(cp, pen):
    if cp == 0x2580:  # upper half
        rect(pen, X0, fy(0.5), X1, Y1)
    elif 0x2581 <= cp <= 0x2588:  # lower n/8 … full
        n = cp - 0x2580
        rect(pen, X0, Y0, X1, fy(n / 8))
    elif 0x2589 <= cp <= 0x258F:  # left 7/8 … 1/8
        n = 0x2590 - cp
        rect(pen, X0, Y0, fx(n / 8), Y1)
    elif cp == 0x2590:  # right half
        rect(pen, fx(0.5), Y0, X1, Y1)
    elif cp in (0x2591, 0x2592, 0x2593):  # shades: a dot grid of 25 / 50 / 75%
        cols, rows = 4, 8
        cw, ch = ADV / cols, (ASC - DESC) / rows
        for r in range(rows):
            for c in range(cols):
                on = {
                    0x2591: (r % 2 == 0 and c % 2 == 0),
                    0x2592: ((r + c) % 2 == 0),
                    0x2593: not (r % 2 == 1 and c % 2 == 1),
                }[cp]
                if on:
                    rect(pen, c * cw, DESC + r * ch, (c + 1) * cw, DESC + (r + 1) * ch)
    elif cp == 0x2594:  # upper 1/8
        rect(pen, X0, fy(7 / 8), X1, Y1)
    elif cp == 0x2595:  # right 1/8
        rect(pen, fx(7 / 8), Y0, X1, Y1)
    else:  # quadrants 2596–259F
        q = {
            0x2596: "LL", 0x2597: "LR", 0x2598: "UL", 0x2599: "UL LL LR",
            0x259A: "UL LR", 0x259B: "UL UR LL", 0x259C: "UL UR LR", 0x259D: "UR",
            0x259E: "UR LL", 0x259F: "UR LL LR",
        }[cp].split()
        # Quarters overlap a little across the middle: two shapes that only
        # touch leave an anti-aliased hairline where they meet (it striped
        # Claude Code's mascot).
        m = 24
        for part in q:
            left = part[1] == "L"
            upper = part[0] == "U"
            rect(pen, X0 if left else fx(0.5) - m, fy(0.5) - m if upper else Y0,
                 fx(0.5) + m if left else X1, Y1 if upper else fy(0.5) + m)


# ---- Box drawing -----------------------------------------------------------

WEIGHTS = {"LIGHT": "light", "HEAVY": "heavy", "DOUBLE": "double", "SINGLE": "light"}
DIRS = {"UP": ["up"], "DOWN": ["down"], "LEFT": ["left"], "RIGHT": ["right"],
        "VERTICAL": ["up", "down"], "HORIZONTAL": ["left", "right"]}


def parse_box(name):
    """'BOX DRAWINGS DOWN LIGHT AND RIGHT HEAVY' → ({'down': 'light', 'right': 'heavy'}, arc?)."""
    words = name.replace("BOX DRAWINGS ", "")
    arc = " ARC " in f" {words} "
    for dash in ("DOUBLE DASH", "TRIPLE DASH", "QUADRUPLE DASH"):
        words = words.replace(dash, "")
    words = words.replace("ARC", "")
    if "DIAGONAL" in words:
        return None, False
    arms = {}
    parts = [p.split() for p in words.split(" AND ")]
    # A part with no weight takes the nearest one given ("LIGHT DOWN AND RIGHT").
    weights = [next((WEIGHTS[w] for w in p if w in WEIGHTS), None) for p in parts]
    for i, w in enumerate(weights):
        if w is None:
            weights[i] = next((x for x in weights[i::-1] if x), None) or next(
                (x for x in weights[i:] if x), "light")
    for p, w in zip(parts, weights):
        for word in p:
            for d in DIRS.get(word, []):
                arms[d] = w
    return arms, arc


def box(cp, pen):
    arms, arc = parse_box(unicodedata.name(chr(cp)))
    if not arms:
        return False
    if arc:
        # Rounded corner: a quarter circle joining the two arms, light weight.
        t = W["light"]
        (vy, vdir), (hx, hdir) = (
            (Y1, "up") if "up" in arms else (Y0, "down"),
            (X1, "right") if "right" in arms else (X0, "left"),
        )
        r = min(ADV / 2, (ASC - DESC) / 2)
        sx = 1 if hdir == "right" else -1
        sy = 1 if vdir == "up" else -1
        # Arc centre sits r from the cell centre, towards the two arms.
        acx, acy = CX + sx * r, CY + sy * r
        outer, inner = [], []
        steps = 12
        for i in range(steps + 1):
            a = math.pi / 2 * i / steps
            # From the vertical arm (pointing back towards centre) to the horizontal arm.
            dx, dy = -sx * math.cos(a), -sy * math.sin(a)
            outer.append((acx + dx * (r + t / 2), acy + dy * (r + t / 2)))
            inner.append((acx + dx * (r - t / 2), acy + dy * (r - t / 2)))
        poly(pen, outer + inner[::-1])
        # Straight runs from the arc's ends out past the cell edges.
        rect(pen, CX - t / 2, min(acy, vy), CX + t / 2, max(acy, vy))
        rect(pen, min(acx, hx), CY - t / 2, max(acx, hx), CY + t / 2)
        return True
    centre = max((W.get(w, DOUBLE_STROKE * 2 + DOUBLE_GAP) for w in arms.values()), default=0)
    for d, w in arms.items():
        if w == "double":
            off = (DOUBLE_GAP + DOUBLE_STROKE) / 2
            for o in (-off, off):
                if d in ("up", "down"):
                    y0, y1 = (CY - off, Y1) if d == "up" else (Y0, CY + off)
                    rect(pen, CX + o - DOUBLE_STROKE / 2, y0, CX + o + DOUBLE_STROKE / 2, y1)
                else:
                    x0, x1 = (CX - off, X1) if d == "right" else (X0, CX + off)
                    rect(pen, x0, CY + o - DOUBLE_STROKE / 2, x1, CY + o + DOUBLE_STROKE / 2)
        else:
            t = W[w]
            if d == "up":
                rect(pen, CX - t / 2, CY - t / 2, CX + t / 2, Y1)
            elif d == "down":
                rect(pen, CX - t / 2, Y0, CX + t / 2, CY + t / 2)
            elif d == "left":
                rect(pen, X0, CY - t / 2, CX + t / 2, CY + t / 2)
            else:
                rect(pen, CX - t / 2, CY - t / 2, X1, CY + t / 2)
    # Fill the join where arms of different weights meet.
    if len(arms) > 1 and all(w != "double" for w in arms.values()):
        rect(pen, CX - centre / 2, CY - centre / 2, CX + centre / 2, CY + centre / 2)
    return True


def main():
    order = [".notdef", "space"]
    cmap = {0x20: "space"}
    glyphs = {}
    metrics = {}

    pen = TTGlyphPen(None)
    rect(pen, 100, 0, ADV - 100, ASC - 200)
    glyphs[".notdef"] = pen.glyph()
    glyphs["space"] = TTGlyphPen(None).glyph()

    for cp in list(range(0x2500, 0x2580)) + list(range(0x2580, 0x25A0)):
        pen = TTGlyphPen(None)
        ok = blocks(cp, pen) if cp >= 0x2580 else box(cp, pen)
        if ok is False:
            continue
        name = f"uni{cp:04X}"
        glyphs[name] = pen.glyph()
        order.append(name)
        cmap[cp] = name

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    # The left side bearing must be each glyph's real left edge. With 0 for
    # all, renderers slid every glyph until its ink began at the cell's left
    # edge — a right-half block drew in the left half.
    glyf = fb.font["glyf"]
    for name in order:
        g = glyf[name]
        g.recalcBounds(glyf)
        metrics[name] = (ADV, g.xMin if g.numberOfContours else 0)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASC, descent=DESC)
    fb.setupNameTable({"familyName": "CR Terminal Blocks", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=ASC, sTypoDescender=DESC, usWinAscent=ASC, usWinDescent=-DESC)
    fb.setupPost()
    out = Path(__file__).resolve().parents[2] / "src/renderer/src/assets/cr-terminal-blocks.ttf"
    out.parent.mkdir(parents=True, exist_ok=True)
    fb.save(str(out))
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(cmap) - 1} glyphs)")


if __name__ == "__main__":
    main()
