"""
Key Differentiators: head-to-head matrix against the alternatives (measured where we measured them) +
why an operator would pick PACT. Native shapes and a native table only (no reused images).
    python build_s_diff.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, RTINT, TINT, VIOLET, WHITE, box, clear_body,
                          find_slide, label_box, notes, rgb, text)
from build_sample import answer, guide

OUT_FILE = os.path.join(B.OUT, "PACT_diff.pptx")
SOFT = "F7F8F7"


def matrix(s, x, y, w):
    cols = [("Central hub", "most fleets today"), ("Greedy nearest", "simple swarms"),
            ("Market auction", "CBBA, research standard"), ("PACT", "ours")]
    rows = [
        ("Keeps working when the hub dies", [("N", "44.7% on time"), ("Y", "66.5%"), ("Y", "73.1%"), ("Y", "72.5% · no drop")]),
        ("Never delivers a parcel twice in a radio split", [("Y", ""), ("Y", ""), ("N", "17.8 per run"), ("Y", "0 in 240 runs")]),
        ("Respects priorities and deadlines", [("Y", ""), ("N", ""), ("Y", ""), ("Y", "")]),
        ("Safe rule for a cut-off group", [("-", "no group"), ("N", ""), ("N", ""), ("Y", "STRICT / QUORUM / OPT.")]),
        ("Plans ahead for radio shadows", [("N", ""), ("N", ""), ("N", ""), ("Y", "learned radio map")]),
        ("Re-claims a failed drone's parcel", [("N", "66.1 s"), ("N", "70.0 s"), ("N", "71.6 s"), ("Y", "9.7 s")]),
    ]
    gives = ["resilience", "priorities", "correctness", "nothing"]
    cw0 = 172
    cw = (w - cw0) / 4
    rh, hh = 37, 38
    tbl = s.shapes.add_table(len(rows) + 2, 5, Pt(x), Pt(y), Pt(w), Pt(hh + rh * (len(rows) + 1))).table
    tp = tbl._tbl.tblPr
    for a in ("firstRow", "bandRow"):
        tp.set(a, "0")
    st = tp.find(qn("a:tableStyleId"))
    if st is not None:
        tp.remove(st)
    tbl.columns[0].width = Pt(cw0)
    for j in range(1, 5):
        tbl.columns[j].width = Pt(cw)
    tbl.rows[0].height = Pt(hh)
    for i in range(1, len(rows) + 2):
        tbl.rows[i].height = Pt(rh)

    def cell(i, j, paras, fill, align="c"):
        c = tbl.cell(i, j)
        c.fill.solid()
        c.fill.fore_color.rgb = rgb(fill)
        c.margin_left = c.margin_right = Pt(6)
        c.margin_top = c.margin_bottom = Pt(1)
        c.vertical_anchor = MSO_ANCHOR.MIDDLE
        text(s, 0, 0, 0, 0, paras, size=9, color=INK, align=align, spacing=1.0, shape=c)
        tcPr = c._tc.get_or_add_tcPr()
        for k, tag in enumerate(("a:lnL", "a:lnR", "a:lnT", "a:lnB")):
            ln = tcPr.makeelement(qn(tag), {"w": "9525"})
            sf = ln.makeelement(qn("a:solidFill"), {})
            clr = sf.makeelement(qn("a:srgbClr"), {"val": "D5D8DB"})
            sf.append(clr); ln.append(sf); tcPr.insert(k, ln)

    cell(0, 0, [[("Same maps, faults and seeds", {"size": 8, "color": MUTED})]], WHITE, "l")
    for j, (n, sub) in enumerate(cols, start=1):
        pact = n == "PACT"
        cell(0, j, [[(n, {"bold": True, "size": 10.5, "color": INK})],
                    [(sub, {"size": 7.2, "color": INK if pact else MUTED})]], LIME if pact else WHITE)
    sym = {"Y": ("✓", DEEP), "N": ("✗", RED), "-": ("–", MUTED)}
    for i, (label, vals) in enumerate(rows, start=1):
        band = WHITE if i % 2 else SOFT
        cell(i, 0, [[(label, {"bold": True, "size": 9})]], band, "l")
        for j, (k, note) in enumerate(vals, start=1):
            g, c = sym[k]
            pact = j == 4
            paras = [[(g + ("  " + note if note else ""), {"bold": True, "size": 9.5 if note else 12, "color": c})]]
            cell(i, j, paras, TINT if pact else band)
    last = len(rows) + 1
    cell(last, 0, [[("What it gives up", {"bold": True, "size": 10})]], WHITE, "l")
    for j, g in enumerate(gives, start=1):
        pact = j == 4
        cell(last, j, [[(g, {"bold": True, "size": 11, "color": INK if pact else RED})]], LIME if pact else RTINT)
    return hh + rh * (len(rows) + 1)


def icon(s, x, y, kind):
    """Small native icons in a lime circle."""
    box(s, x, y, 30, 30, fill=LIME, shape=MSO_SHAPE.OVAL)
    if kind == "nohub":
        box(s, x + 10, y + 7, 10, 16, fill=INK, radius=2)
        ln = s.shapes.add_connector(1, Pt(x + 6), Pt(y + 24), Pt(x + 24), Pt(y + 6))
        ln.line.color.rgb = rgb(RED)
        ln.line.width = Pt(2.2)
    elif kind == "plug":
        box(s, x + 8, y + 9, 14, 10, fill=INK, radius=2)
        box(s, x + 11, y + 5, 2, 5, fill=INK)
        box(s, x + 17, y + 5, 2, 5, fill=INK)
        box(s, x + 14, y + 19, 2, 6, fill=INK)
    elif kind == "dial":
        box(s, x + 6, y + 6, 18, 18, fill=WHITE, line=INK, lw=1.5, shape=MSO_SHAPE.OVAL)
        ln = s.shapes.add_connector(1, Pt(x + 15), Pt(y + 15), Pt(x + 21), Pt(y + 9))
        ln.line.color.rgb = rgb(INK)
        ln.line.width = Pt(1.8)
    elif kind == "shield":
        label_box(s, x + 7, y + 6, 16, 18, [[("✓", {"bold": True})]], INK, LIME, size=10, radius=4, inset=0)


def diff(s):
    guide(s, "What unique features and advantages set the idea apart from similar solutions? Highlight the key "
             "differentiators.")
    answer(s, [("Every alternative gives up one thing. ", {}),
               ("PACT is the only one that gives up none.", {"color": DEEP})], size=16.5)

    X, W = 42, 560
    text(s, X, 90, W, 13, [[("HEAD TO HEAD", {"bold": True})]], size=8.5, color=DEEP)
    h = matrix(s, X, 106, W)
    text(s, X, 106 + h + 6, W, 26, [[("Measured in our simulator on the same maps, faults and seeds: 30-seed benchmark, "
                                      "240-run radio-split sweep, 30-seed shadow runs, 95% confidence intervals. "
                                      "Market auction = PACT's own auction with fencing removed.", {})]],
         size=7.6, color=MUTED, spacing=1.03)

    RX, RW = 620, 298
    text(s, RX, 90, RW, 13, [[("WHY AN OPERATOR PICKS PACT", {"bold": True})]], size=8.5, color=DEEP)
    adv = [("nohub", "No hub to buy, run or lose",
            "No server, no single outage. A hub with hot standby costs about ₹73,400 a year in cloud compute alone."),
           ("plug", "Fits the drones you already fly",
            "Runs beside PX4 on a ₹17k companion computer + radio. Software licences: ₹0."),
           ("dial", "Safety you can dial",
            "Pick STRICT, QUORUM or OPTIMISTIC per site, from never-risk to keep-moving."),
           ("shield", "Proven, not promised",
            "1,260 measured runs, a TLA+ model check, and every run replays from its seed.")]
    for i, (k, t, d) in enumerate(adv):
        y = 106 + i * 91
        box(s, RX, y, RW, 84, fill=WHITE, line=LINE, radius=8)
        icon(s, RX + 10, y + 12, k)
        text(s, RX + 48, y + 9, RW - 56, 16, [[(t, {"bold": True})]], size=11.5, color=INK)
        text(s, RX + 48, y + 29, RW - 56, 50, d, size=9.4, color=INK, spacing=1.08)
    notes(s, "Read the PACT column first: the only one with every tick. Then the costs of the alternatives: the hub "
             "stalls, the auction double-delivers, greedy ignores priorities. Right side: what that means for an "
             "operator. Prices are on the cost slide.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    sl = find_slide(prs, "Key Differentiators:")
    clear_body(sl)
    diff(sl)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not sl.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
