#!/usr/bin/env python3
"""Hash and render pages of a Supernote .note file.

Usage: render.py NOTE_PATH OUT_DIR < known.json
       render.py --strokes NOTE_PATH PAGEID

stdin is a JSON object mapping pageid -> hash from the previous sync (may be
empty). Pages whose hash differs from the known one are rendered to
OUT_DIR/<pageid>.png. stdout is a JSON object:

  {"pages": [{"index": 1, "pageid": "...", "hash": "...", "png": "path"|null,
              "blank": bool|null, "top": int|null, "width": int|null}]}

blank, top (first pixel row kept by the crop) and width are set for rendered pages only.
Rendered pages also get "strokes" (see page_strokes), which the Obsidian plugin uses to show
a whole-stroke erase before the re-rendered image arrives. --strokes prints {"strokes": [...]}
for one page.

The hash covers the raw layer bitmaps and the page template, so it changes
only when ink or background changes. Pages are rendered as ink only
(see ink_png).
"""
import hashlib
import json
import os
import sys

import struct

import numpy as np
import supernotelib as sn
from PIL import Image, ImageChops
from supernotelib.converter import ImageConverter, VisibilityOverlay, build_visibility_overlay

# Hide the template layer (dot grid, lines) so only ink is rendered.
INK_ONLY = build_visibility_overlay(background=VisibilityOverlay.INVISIBLE)
# Part of every page hash; bump it when the rendered output changes so existing pages re-render.
RENDER_VERSION = b"ink-1"


def page_hash(page):
    h = hashlib.sha256(RENDER_VERSION)
    h.update((page.get_style() or "").encode())
    h.update((page.get_style_hash() or "").encode())
    if page.is_layer_supported():
        for layer in page.get_layers():
            content = layer.get_content()
            h.update(b"\0L")
            if content:
                h.update(content)
    else:
        content = page.get_content()
        if content:
            h.update(content)
    return h.hexdigest()


def ink_png(converter, index):
    """Renders a page as black ink on a transparent background, at full page size.

    The page is not cropped, so strokes drawn live over the image while writing stay inside
    it. Returns (image, blank, top); top is always 0. Darkness becomes opacity, so gray pens and highlighter stay lighter than black ink.
    The theme's CSS then recolors the ink to match the note text.
    """
    img = converter.convert(index, INK_ONLY).convert("RGBA")
    white = Image.new("RGBA", img.size, (255, 255, 255, 255))
    gray = Image.alpha_composite(white, img).convert("L")
    alpha = ImageChops.invert(gray)
    out = Image.new("LA", img.size, 0)
    out.putalpha(alpha)
    blank = alpha.point(lambda a: 255 if a > 24 else 0).getbbox() is None
    return out, blank, 0


# TOTALPATH pen types that are not ink: eraser motions and lasso loops.
ERASER, LASSO = 3, 4
# An eraser record erases every earlier stroke with a sample point this close (page pixels).
# Measured 2026-09-27: erased strokes were within 2.2 px of the eraser path, visible ones over 100 px away.
ERASE_RADIUS = 8
# Sample points closer than this to the previous kept point are dropped from the output.
MIN_STEP = 3


def inside(points, polygon):
    """Which of `points` (n x 2) lie inside `polygon` (m x 2, closed implicitly), by ray casting."""
    x, y = points[:, 0:1], points[:, 1:2]
    ax, ay = polygon[:, 0], polygon[:, 1]
    bx, by = np.roll(ax, -1), np.roll(ay, -1)
    crosses = (ay > y) != (by > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        at = ax + (y - ay) * (bx - ax) / (by - ay)
    return ((crosses & (x < at)).sum(1) % 2) == 1


def page_strokes(page, width, height):
    """Visible strokes of a page as [{"w": pen width units, "p": [x0, y0, x1, y1, ...]}] in page pixels.

    TOTALPATH is a u32 record count, then per record a u32 size and the record: u32 pen type at
    0, pen width at 8, the coordinate space (rows, columns) at 128 and 132, and at 212 a u32
    point count followed by (row, column) u32 pairs. Columns run right to left. The block keeps
    erased strokes and the eraser motions themselves. The eraser removes every stroke its path
    touches and every stroke inside the loop it draws, so a stroke that a later eraser record
    passes within ERASE_RADIUS of, or that has a point inside that record's path taken as a
    closed polygon, is left out. Decoded from files written by Chauvet 3.x (Nomad).
    """
    block = page.get_totalpath()
    if not block:
        return []
    records = []
    count = struct.unpack_from("<I", block, 0)[0]
    off = 4
    for _ in range(count):
        size = struct.unpack_from("<I", block, off)[0]
        rec = block[off + 4 : off + 4 + size]
        off += 4 + size
        kind, pen_width = struct.unpack_from("<I", rec, 0)[0], struct.unpack_from("<I", rec, 8)[0]
        rows, cols = struct.unpack_from("<II", rec, 128)
        n = struct.unpack_from("<I", rec, 212)[0]
        if not n or not rows or not cols:
            continue
        raw = np.frombuffer(rec, dtype="<u4", count=2 * n, offset=216).reshape(n, 2).astype(float)
        xy = np.stack([width - raw[:, 1] * width / cols, raw[:, 0] * height / rows], 1)
        records.append((kind, pen_width, xy))
    erased = set()
    for e, (kind, _, exy) in enumerate(records):
        if kind != ERASER:
            continue
        lo, hi = exy.min(0) - ERASE_RADIUS, exy.max(0) + ERASE_RADIUS
        for k in range(e):
            if k in erased or records[k][0] in (ERASER, LASSO):
                continue
            xy = records[k][2]
            near = xy[((xy >= lo) & (xy <= hi)).all(1)]
            if not len(near):
                continue
            if (((near[:, None, :] - exy[None, :, :]) ** 2).sum(2) <= ERASE_RADIUS**2).any() or inside(near, exy).any():
                erased.add(k)
    out = []
    for k, (kind, pen_width, xy) in enumerate(records):
        if kind in (ERASER, LASSO) or k in erased:
            continue
        kept = [xy[0]]
        for pt in xy[1:]:
            if abs(pt[0] - kept[-1][0]) + abs(pt[1] - kept[-1][1]) >= MIN_STEP:
                kept.append(pt)
        if len(kept) == 1 or (kept[-1] != xy[-1]).any():
            kept.append(xy[-1])
        out.append({"w": pen_width, "p": [round(float(v), 1) for pt in kept for v in pt]})
    return out


def strokes_main():
    note_path, pageid = sys.argv[2], sys.argv[3]
    notebook = sn.load_notebook(note_path)
    for i in range(notebook.get_total_pages()):
        page = notebook.get_page(i)
        if (page.get_pageid() or f"index-{i}") == pageid:
            json.dump({"strokes": page_strokes(page, notebook.get_width(), notebook.get_height())}, sys.stdout)
            return
    json.dump({"strokes": []}, sys.stdout)


def main():
    if sys.argv[1] == "--strokes":
        return strokes_main()
    note_path, out_dir = sys.argv[1], sys.argv[2]
    known = json.loads(sys.stdin.read() or "{}")
    os.makedirs(out_dir, exist_ok=True)

    notebook = sn.load_notebook(note_path)
    converter = ImageConverter(notebook)
    pages = []
    for i in range(notebook.get_total_pages()):
        page = notebook.get_page(i)
        pageid = page.get_pageid() or f"index-{i}"
        digest = page_hash(page)
        png = blank = top = width = strokes = None
        if known.get(pageid) != digest:
            png = os.path.join(out_dir, f"{pageid}.png")
            img, blank, top = ink_png(converter, i)
            width = img.width
            img.save(png, format="PNG", optimize=True)
            strokes = page_strokes(page, img.width, img.height)
        pages.append({"index": i + 1, "pageid": pageid, "hash": digest, "png": png, "blank": blank, "top": top, "width": width, "strokes": strokes})

    json.dump({"pages": pages}, sys.stdout)


if __name__ == "__main__":
    main()
