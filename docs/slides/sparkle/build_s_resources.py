"""
Technical Details and Reports (resources): every headline number in the deck and where it comes from, quick links
(QR codes), the research we cite, and the price sources.
    python build_s_resources.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.text import MSO_ANCHOR
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, TINT, VIOLET, WHITE, add_continuation, box,
                          label_box, notes, picture, rgb, text)
from build_sample import answer, guide

OUT_FILE = os.path.join(B.OUT, "PACT_resources.pptx")
SOFT = "F7F8F7"
REPO = "https://github.com/MrNK2107/PACT"

CLAIMS = [
    ("72.5% vs 44.7% on time after the hub dies", "benchmark, 30 seeds × 900 s", "results/summary.md"),
    ("66.5% greedy · 73.1% plain auction (52 duplicates)", "same benchmark, same seeds", "results/summary.md"),
    ("0 vs 17.8 double deliveries per run", "240-run radio-split sweep, 30 seeds", "results/sweep/sweep.md"),
    ("9.7 s vs 66–72 s to re-claim", "drone-failure scenario, 30 seeds", "results/recovery.json"),
    ("False failovers 14.3 → 6.3 (−56%), deliveries +5.6%", "planned silence, canyon map, 30 seeds", "results/radiomap/"),
    ("201,334,513 states, 0 violations", "TLA+ model, TLC 1.7.4", "docs/formal/RESULTS.md"),
    ("Fence removed / drift ignored: caught in 9 steps", "TLC counterexamples (mutant models)", "docs/formal/"),
    ("391 + 75/75 · 692 + 9/9 + 4/4 PX4 SITL", "simulator and AeroPACT test suites", "README.md"),
    ("How to reproduce every number", "make bench · sweep · radiomap", "README.md"),
]
PRICES = [("Raspberry Pi 5 4 GB ₹13,409", "robu.in"), ("ESP32-S3 ₹1,299", "probots.co.in"),
          ("microSD ₹1,649", "computechstore.in"), ("UBEC ₹362", "zbotic.in"), ("Cooler ₹499", "indianhobbycenter.com"),
          ("Hub: 2 × EC2 t3.medium, Mumbai, $0.0448/h", "doit.com"),
          ("Exchange rate ₹93.5 per US$", "18 Nov 2026"), ("Problem statement", "sparkle.kpit.com"),
          ("Expert insights", "SIH 2026 review at BEL")]
REFS = [("Choi, Brunet, How", "Consensus-based decentralized auctions (CBBA)", "IEEE T-RO 2009"),
        ("Shapiro et al.", "Conflict-free replicated data types", "SSS 2011"),
        ("Gray, Cheriton", "Leases for distributed file cache consistency", "SOSP 1989"),
        ("Kleppmann", "Designing Data-Intensive Applications (fencing tokens)", "O'Reilly 2017"),
        ("Hayashibara et al.", "The φ accrual failure detector", "SRDS 2004"),
        ("Das, Gupta, Motivala", "SWIM membership protocol", "DSN 2002"),
        ("Gilbert, Lynch", "Brewer's conjecture (CAP)", "SIGACT News 2002"),
        ("Lamport", "Specifying Systems (TLA+)", "Addison-Wesley 2002")]


def resources(s):
    guide(s, "A brief overview of the research behind the idea; showcase the analysis, findings or insights.")
    answer(s, [("Every number in this deck, ", {}), ("and exactly where it comes from.", {"color": DEEP})], size=16)

    # ---- claim -> source -------------------------------------------------------------
    X, W = 42, 560
    text(s, X, 90, W, 13, [[("CLAIM → SOURCE · all files in github.com/MrNK2107/PACT", {"bold": True})]], size=8,
         color=DEEP)
    n = len(CLAIMS)
    rh = 28
    tbl = s.shapes.add_table(n + 1, 3, Pt(X), Pt(106), Pt(W), Pt(rh * (n + 1))).table
    tp = tbl._tbl.tblPr
    for a in ("firstRow", "bandRow"):
        tp.set(a, "0")
    st = tp.find(qn("a:tableStyleId"))
    if st is not None:
        tp.remove(st)
    for j, wdt in enumerate((238, 168, 154)):
        tbl.columns[j].width = Pt(wdt)

    def cell(i, j, paras, fill):
        c = tbl.cell(i, j)
        c.fill.solid()
        c.fill.fore_color.rgb = rgb(fill)
        c.margin_left = c.margin_right = Pt(6)
        c.margin_top = c.margin_bottom = Pt(1)
        c.vertical_anchor = MSO_ANCHOR.MIDDLE
        text(s, 0, 0, 0, 0, paras, size=7.8, color=INK, spacing=1.0, shape=c)
        tcPr = c._tc.get_or_add_tcPr()
        for k, tag in enumerate(("a:lnL", "a:lnR", "a:lnT", "a:lnB")):
            ln = tcPr.makeelement(qn(tag), {"w": "9525"})
            sf = ln.makeelement(qn("a:solidFill"), {})
            sf.append(sf.makeelement(qn("a:srgbClr"), {"val": "D5D8DB"}))
            ln.append(sf)
            tcPr.insert(k, ln)

    for j, h in enumerate(("Claim on the slides", "How it was measured", "Source")):
        cell(0, j, [[(h, {"bold": True, "color": DEEP, "size": 7.6})]], TINT)
    for i, (c1, c2, c3) in enumerate(CLAIMS, start=1):
        band = WHITE if i % 2 else SOFT
        cell(i, 0, [[(c1, {"bold": True})]], band)
        cell(i, 1, [[(c2, {"color": MUTED})]], band)
        cell(i, 2, [[(c3, {"bold": True, "color": VIOLET, "size": 7.6})]], band)
    for r in tbl.rows:
        r.height = Pt(rh)

    # prices
    py = 106 + rh * (n + 1) + 8
    box(s, X, py, W, 476 - py, fill=SOFT, line=LINE, radius=7)
    text(s, X + 10, py + 4, W - 20, 12, [[("PRICES · live Indian listings incl. GST, checked 20 Nov 2026", {"bold": True})]],
         size=7.4, color=DEEP)
    pw = (W - 20) / 3
    for i, (t, src) in enumerate(PRICES):
        x = X + 10 + (i % 3) * pw
        y = py + 20 + (i // 3) * 17
        text(s, x, y, pw - 6, 15, [[(t + "  ", {"color": INK}), (src, {"color": MUTED, "size": 6.8})]], size=7.8,
             anchor="m")

    # ---- quick links -------------------------------------------------------------------
    RX, RW = 618, 300
    text(s, RX, 90, RW, 13, [[("QUICK LINKS · SCAN OR CLICK", {"bold": True})]], size=8, color=DEEP)
    links = [("qr_repo.png", "Source code", "GitHub repository", REPO),
             ("qr_video.png", "Demo video", "3-minute walkthrough",
              "https://drive.google.com/file/d/1qlPbHO_VTEOLMpG-KsM2Ratiawf_xRO6/view?usp=sharing"),
             ("qr_docs.png", "Reports", "summary · design · evaluation · setup",
              "https://drive.google.com/drive/folders/1-udBn0FYfy1-YIIxnf0yAcD5kpeAF4en?usp=sharing")]
    lw = (RW - 2 * 8) / 3
    for i, (img, t, d, url) in enumerate(links):
        x = RX + i * (lw + 8)
        box(s, x, 106, lw, 112, fill=WHITE, line=LINE, radius=7)
        q = picture(s, img, x + (lw - 70) / 2, 112, 70, 70)
        q.click_action.hyperlink.address = url
        text(s, x + 4, 184, lw - 8, 32, [[(t, {"bold": True, "color": INK, "size": 8.6, "link": url})],
                                         [(d, {"size": 6.4, "color": MUTED})]], align="c", spacing=1.0)

    # ---- references --------------------------------------------------------------------
    box(s, RX, 226, RW, 250, fill=WHITE, line=LINE, radius=7)
    text(s, RX + 10, 231, RW - 20, 12, [[("RESEARCH WE BUILD ON", {"bold": True})]], size=7.4, color=DEEP)
    for i, (a, t, v) in enumerate(REFS):
        y = 249 + i * 27
        text(s, RX + 10, y, RW - 20, 23, [[(t, {"bold": True, "color": INK, "size": 8})],
                                          [(a + " · " + v, {"size": 7, "color": MUTED})]], spacing=1.0)
    notes(s, "Backup slide. If a judge asks where a number comes from, point to its row: every claim maps to a file "
             "in the repository, and every price to a dated Indian listing. QR codes open the code, the demo video and "
             "the four reports.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    sl = add_continuation(prs, "Technical Details and Reports ")
    resources(sl)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not sl.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
