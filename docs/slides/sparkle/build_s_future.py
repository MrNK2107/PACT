"""
Future Plans/potential next steps: the road to real hardware. Dated phases with measurable targets, the planned
indoor test rig (arena illustration with callouts), a sourced per-drone test-kit cost, and features to add.
    python build_s_future.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, TINT, VIOLET, VTINT, WHITE, box, clear_body,
                          find_slide, label_box, notes, picture, text)
from build_sample import answer, callout, guide, line

OUT_FILE = os.path.join(B.OUT, "PACT_future.pptx")
SOFT = "F7F8F7"


def future(s):
    guide(s, "Future features, functionalities or improvements, with specific and measurable targets in a defined "
             "timeframe.")
    answer(s, [("Next: take PACT off the simulator and onto real drones, ", {}),
               ("one measured step at a time.", {"color": DEEP})], size=16)

    # ---- roadmap ---------------------------------------------------------------
    phases = [("DONE · OCT 2026", "Software prototype", "Two working builds, 1,260 measured runs",
               "No drop after hub loss · 0 duplicates · TLA+ checked", True),
              ("PHASE 1 · DEC 2026 – FEB 2027", "Hardware in the loop",
               "PACT on Raspberry Pi 5 + ESP32-S3 radios; PX4 flies in simulation",
               "0 duplicates in 100 runs with real radio loss · decision < 50 ms on Pi 5", False),
              ("PHASE 2 · MAR – JUN 2027", "Indoor flight trial",
               "4–6 quadcopters in a netted arena; we kill the hub and cut the radio live",
               "50 missions · 0 duplicates · 0 loss of separation", False),
              ("PHASE 3 · JUL – DEC 2027", "Outdoor pilot",
               "A campus or hospital parcel route with a partner, under DGCA drone rules",
               "200 pilot deliveries · 50+ drones in simulation", False)]
    pw, g, y0, ph = (876 - 3 * 10) / 4, 10, 90, 112
    line(s, 42 + pw / 2, y0 + 10, 42 + 3.5 * pw + 3 * g, y0 + 10, color=LIME, w=2)
    for i, (when, t, d, tgt, done) in enumerate(phases):
        x = 42 + i * (pw + g)
        box(s, x + pw / 2 - 7, y0 + 3, 14, 14, fill=LIME if done else WHITE, line=LIME, lw=2, shape=MSO_SHAPE.OVAL)
        box(s, x, y0 + 22, pw, ph - 22, fill=TINT if done else WHITE, line=LIME if done else LINE, lw=1.2, radius=8)
        text(s, x + 9, y0 + 26, pw - 18, 11, [[(when, {"bold": True})]], size=7.3, color=DEEP)
        text(s, x + 9, y0 + 38, pw - 18, 16, [[(t, {"bold": True})]], size=11.5, color=INK)
        text(s, x + 9, y0 + 55, pw - 18, 24, d, size=8, color=INK, spacing=1.02)
        label_box(s, x + 7, y0 + ph - 25, pw - 14, 21,
                  [[("TARGET  " if not done else "ACHIEVED  ", {"bold": True, "size": 6.4}), (tgt, {"bold": True})]],
                  LIME if done else TINT, INK if done else DEEP, size=7, radius=5, inset=4, align="l")

    # ---- the planned indoor test rig ---------------------------------------------
    X, Y, W, H = 42, 214, 520, 262
    box(s, X - 2, Y - 2, W + 4, H + 4, fill=WHITE, line=LINE, radius=10)
    picture(s, "arena.png", X, Y, W, H, focus=(0.5, 0.4), radius=9)
    iw, ih = 2752, 1536
    vis_h = iw * H / W
    top = (ih - vis_h) * 0.4

    def P(px, py):
        return X + px / iw * W, Y + (py - top) / vis_h * H

    text(s, X + 10, Y + 8, 200, 12, [[("PHASE 2 TEST RIG", {"bold": True})]], size=7.6, color=DEEP)
    callout(s, *P(1020, 450), X + 8, Y + 24, 136, 40, "4–6 PX4 quadcopters",
            "each with a Pi 5 + ESP32-S3 running PACT", DEEP)
    callout(s, *P(1365, 520), X + W - 150, Y + 8, 142, 40, "Depot node", "hands a parcel only to the newest epoch",
            DEEP, fill=TINT)
    callout(s, *P(1100, 740), X + 8, Y + 150, 136, 40, "Charging pads", "reserved through the shared board",
            VIOLET)
    callout(s, *P(1900, 1110), X + W - 160, Y + H - 52, 152, 44, "Test desk", "logs and injects faults: hub kill, "
            "radio cut. It never dispatches.", RED)

    # ---- right: test-kit cost + features to add -----------------------------------
    RX, RW = 578, 340
    box(s, RX, Y, RW, 150, fill=WHITE, line=LINE, radius=8)
    text(s, RX + 10, Y + 6, RW - 20, 12, [[("TEST KIT PER DRONE · LIVE PRICES INCL. GST, 20 NOV 2026", {"bold": True})]],
         size=7, color=DEEP)
    bom = [("Raspberry Pi 5 (4 GB) companion computer", "13,409", "robu.in"),
           ("ESP32-S3 mesh radio", "1,299", "probots.co.in"),
           ("64 GB A2 microSD", "1,649", "computechstore.in"),
           ("5 V / 5 A regulator", "362", "zbotic.in"),
           ("Active cooler and mount", "499", "indianhobbycenter.com")]
    for i, (it, pr, src) in enumerate(bom):
        y = Y + 22 + i * 17
        text(s, RX + 10, y, 210, 16, [[(it + "  ", {"color": INK}), (src, {"size": 6.5, "color": MUTED})]], size=8,
             anchor="m")
        text(s, RX + RW - 80, y, 70, 16, [[("₹" + pr, {"bold": True})]], size=8.5, color=INK, align="r", anchor="m")
    box(s, RX + 10, Y + 110, RW - 20, 0.75, fill=LINE)
    text(s, RX + 10, Y + 113, 160, 30, [[("Per drone ", {"bold": True, "color": INK}), ("₹17,218", {"bold": True, "color": DEEP, "size": 12})]],
         size=9, anchor="m")
    label_box(s, RX + RW - 150, Y + 116, 140, 24, [[("4-drone trial: ₹68,872", {"bold": True})]], LIME, INK, size=8.6,
              radius=6)
    box(s, RX, Y + 158, RW, 104, fill=SOFT, radius=8)
    text(s, RX + 10, Y + 164, RW - 20, 12, [[("FEATURES WE WILL ADD", {"bold": True})]], size=7.4, color=DEEP)
    feats = [("Self-healing relay", "an idle drone flies to bridge a radio gap"),
             ("Wind-aware bids", "routes and energy checks use live wind"),
             ("Airspace feeds", "no-fly and UTM data on the shared board"),
             ("Mixed fleets", "drones from several operators, one protocol")]
    for i, (t, d) in enumerate(feats):
        text(s, RX + 10, Y + 180 + i * 19, RW - 20, 18, [[(t + "  ", {"bold": True, "color": INK}), (d, {})]],
             size=8.2, color=INK, anchor="m")
    notes(s, "We are done with software; the next step is real hardware. Walk the four dates and point at each target. "
             "Then the Phase 2 rig: quadcopters with a Pi 5 and an ESP32-S3 each, a depot node, charging pads, and a "
             "test desk that only logs and injects faults. Prices are live Indian listings incl. GST, 20 Nov 2026.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    sl = find_slide(prs, "Future Plans/potential next steps ")
    clear_body(sl)
    future(sl)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not sl.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
