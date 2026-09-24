#!/usr/bin/env python3
"""Trace a hard-edged, blocky PNG (pixel art, mono icons) into a clean SVG.

vtracer's polygon mode traces blocky art faithfully, but it reads luminance
(so an alpha-only PNG needs flattening first), reproduces 1px upscale jitter,
hardcodes the fill and wraps paths in transforms. For art where every edge is
horizontal or vertical, this traces the rectilinear outline directly:

  1. Threshold alpha (or luminance with --luma) into a filled/empty mask.
  2. Find every x/y where the mask changes, and merge edges closer than
     --snap px. That removes the 1px jitter left by non-integer upscaling.
  3. Resample the mask onto that irregular grid (one cell between each pair
     of edges, majority vote).
  4. Walk the cell boundaries into closed loops, drop collinear points, and
     emit a single <path> with fill-rule="evenodd" so holes stay holes.

Usage: python3 scripts/png-to-svg.py in.png out.svg [--snap 2] [--fill currentColor]
Needs: pip install pillow numpy
"""
import argparse

import numpy as np
from PIL import Image


def load_mask(path, luma):
    im = Image.open(path).convert("RGBA")
    px = np.asarray(im)
    if luma:
        # Dark pixels are the shape; transparent pixels count as empty.
        lum = px[:, :, :3] @ np.array([0.299, 0.587, 0.114])
        return (lum < 128) & (px[:, :, 3] > 127)
    return px[:, :, 3] > 127


def snapped_edges(mask, axis, snap):
    """Positions where the mask flips along `axis`, clustered within `snap` px."""
    flips = np.nonzero(np.diff(mask.astype(np.int8), axis=axis))[axis] + 1
    raw = sorted(set(flips.tolist()))
    size = mask.shape[axis]
    edges = [0]
    group = []
    for v in raw:
        if group and v - group[-1] > snap:
            edges.append(round(sum(group) / len(group)))
            group = []
        group.append(v)
    if group:
        edges.append(round(sum(group) / len(group)))
    edges.append(size)
    return sorted(set(edges))


def resample(mask, xs, ys):
    grid = np.zeros((len(ys) - 1, len(xs) - 1), dtype=bool)
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            grid[j, i] = mask[ys[j]:ys[j + 1], xs[i]:xs[i + 1]].mean() >= 0.5
    return grid


def trace(grid):
    """Directed boundary edges of filled cells, chained into closed loops.

    Edges run clockwise around filled cells (in screen coords), so outer
    outlines and holes come out with opposite winding.
    """
    rows, cols = grid.shape
    filled = lambda j, i: 0 <= j < rows and 0 <= i < cols and grid[j, i]
    out = {}  # start vertex -> list of end vertices (grid index space)
    for j in range(rows):
        for i in range(cols):
            if not grid[j, i]:
                continue
            if not filled(j - 1, i):
                out.setdefault((i, j), []).append((i + 1, j))
            if not filled(j, i + 1):
                out.setdefault((i + 1, j), []).append((i + 1, j + 1))
            if not filled(j + 1, i):
                out.setdefault((i + 1, j + 1), []).append((i, j + 1))
            if not filled(j, i - 1):
                out.setdefault((i, j + 1), []).append((i, j))

    loops = []
    while out:
        start = next(iter(out))
        loop = [start]
        cur, prev_dir = start, None
        while True:
            nexts = out[cur]
            if len(nexts) > 1 and prev_dir is not None:
                # Diagonal-touching cells: always take the right turn so the
                # two cells stay separate loops instead of a figure eight.
                right = (-prev_dir[1], prev_dir[0])
                nexts.sort(key=lambda n: (n[0] - cur[0], n[1] - cur[1]) != right)
            nxt = nexts.pop(0)
            if not nexts:
                del out[cur]
            prev_dir = (nxt[0] - cur[0], nxt[1] - cur[1])
            cur = nxt
            if cur == start:
                break
            loop.append(cur)
        loops.append(loop)
    return loops


def simplify(loop):
    """Drop points that sit on a straight run between their neighbours."""
    n = len(loop)
    keep = []
    for k in range(n):
        a, b, c = loop[k - 1], loop[k], loop[(k + 1) % n]
        if (a[0] == b[0] == c[0]) or (a[1] == b[1] == c[1]):
            continue
        keep.append(b)
    return keep


def to_path(loops, xs, ys):
    parts = []
    for loop in loops:
        pts = [(xs[i], ys[j]) for i, j in simplify(loop)]
        d = f"M{pts[0][0]} {pts[0][1]}"
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            d += f"H{x1}" if y0 == y1 else f"V{y1}"
        parts.append(d + "Z")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--snap", type=int, default=2, help="merge edges within N px (default 2)")
    ap.add_argument("--fill", default="currentColor", help="fill colour (default currentColor)")
    ap.add_argument("--luma", action="store_true", help="use dark pixels instead of alpha")
    args = ap.parse_args()

    mask = load_mask(args.inp, args.luma)
    h, w = mask.shape
    xs = snapped_edges(mask, 1, args.snap)
    ys = snapped_edges(mask, 0, args.snap)
    grid = resample(mask, xs, ys)
    loops = trace(grid)
    d = to_path(loops, xs, ys)

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'shape-rendering="crispEdges">\n'
        f'  <path fill="{args.fill}" fill-rule="evenodd" d="{d}"/>\n'
        f"</svg>\n"
    )
    with open(args.out, "w") as f:
        f.write(svg)

    print(f"{args.out}: {len(loops)} loops, {len(d)} bytes of path data, "
          f"{len(xs) - 1}x{len(ys) - 1} cell grid")


if __name__ == "__main__":
    main()
