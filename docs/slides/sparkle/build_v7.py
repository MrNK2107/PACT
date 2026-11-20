"""
v7: slide 1 = locked v6 innovation slide; slide 2 = technical slide designed for its own question:
research (strip) -> how it works (one top-to-bottom flow, left) -> findings (charts, dark panel, right).
    python build_v7.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, RTINT, SLATE, TINT, VIOLET, VTINT, WHITE,
                          box, clear_body, find_slide, label_box, notes, picture, text)
from build_sample import answer, dot, guide, line
from build_v6 import innovation

OUT_FILE = os.path.join(B.OUT, "PACT_sample_v7.pptx")
SOFT = "F7F8F7"
DARK2 = "34302F"     # bar track on the dark panel
GREYBAR = "8E949A"


def down_arrow(s, x, y, color=MUTED):
    a = s.shapes.add_shape(MSO_SHAPE.DOWN_ARROW, B.Pt(x), B.Pt(y), B.Pt(10), B.Pt(8))
    B._strip_style(a)
    a.fill.solid()
    a.fill.fore_color.rgb = B.rgb(color)
    a.line.fill.background()


def stage_row(s, y, h, name, accent, tagtxt, research):
    """One stage of the flow: accent bar, name, module tag, research badge. Returns the content x."""
    box(s, 42, y, 518, h, fill=WHITE, line=LINE, radius=7)
    box(s, 42, y, 5, h, fill=accent)
    text(s, 54, y + 4, 80, 16, [[(name, {"bold": True})]], size=11.5, color=INK)
    label_box(s, 54, y + h - 18, 74, 13, [[(research, {"bold": True})]], SOFT, MUTED, size=6.3, radius=3, inset=2)
    label_box(s, 274, y + 5, 278, 13, [[(tagtxt, {"bold": True})]], GREY, INK, size=7, radius=3, inset=4, align="l")


def hbar(s, x, y, w, label_txt, value, vmax, color, value_txt, lab_w=96, h=9, label_color=WHITE):
    text(s, x, y - 2, lab_w, h + 4, label_txt, size=7.2, color=label_color, anchor="m")
    bx = x + lab_w + 4
    bw = w - lab_w - 4 - 40
    box(s, bx, y, bw, h, fill=DARK2, radius=2)
    if value > 0:
        box(s, bx, y, max(2.5, bw * value / vmax), h, fill=color, radius=2)
    text(s, bx + bw + 4, y - 2, 36, h + 4, [[(value_txt, {"bold": True})]], size=7.8, color=color if color != GREYBAR else "D6D9DC",
         anchor="m", align="r")


def technical(s):
    guide(s, "A brief overview of the research behind the idea; then showcase the analysis, findings or insights "
             "with charts or graphs.")
    answer(s, [("Six proven ideas from distributed systems, ", {}),
               ("rebuilt for drones that lose radio, crash and drift.", {"color": DEEP})], size=14)

    # ---- research strip ---------------------------------------------------
    text(s, 42, 84, 80, 18, [[("BUILT ON", {"bold": True})]], size=8, color=DEEP, anchor="m")
    refs = ["Market auctions · Choi 2009", "CRDTs · Shapiro 2011", "Leases · Gray & Cheriton 1989",
            "Fencing tokens · Kleppmann 2017", "φ-accrual + SWIM · 2004 / 2002",
            "CAP · Gilbert & Lynch 2002"]
    x = 96
    for r in refs:
        w = 8 + len(r) * 4.2
        label_box(s, x, 86, w, 15, r, TINT, DEEP, size=7.2, radius=7, inset=2)
        x += w + 6

    # ---- how it works: one top-to-bottom flow (left) -------------------------
    text(s, 42, 106, 300, 12, [[("HOW IT WORKS · ONE PARCEL, ONE ROS 2 STACK PER DRONE", {"bold": True})]], size=7.8,
         color=INK)
    rows_y = [120, 186, 252, 318, 384]
    rh = 58
    # Job in
    y = rows_y[0]
    stage_row(s, y, rh, "Job in", INK, "aeropact_depot · TaskRecord", "depot")
    box(s, 140, y + 6, 126, 46, fill=SOFT, radius=4)
    text(s, 145, y + 7, 120, 44, [[("J-0142", {"bold": True}), ("  D1 → P7", {})],
                                  [("priority ", {"color": MUTED}), ("P1", {"bold": True, "color": RED}), (" · deadline", {})],
                                  [("epoch 0 · unassigned", {"color": MUTED})]], size=7.4, color=INK, spacing=1.05)
    text(s, 274, y + 21, 280, 34, "Only depots create jobs and hand off parcels. A new P1 job triggers an immediate "
                                  "re-auction.", size=8.2, color=INK, spacing=1.04)
    # Decide
    y = rows_y[1]
    stage_row(s, y, rh, "Decide", DEEP, "aeropact_agent · lifecycle node · auction every 2 s", "Choi 2009")
    for i, (cx, cy) in enumerate([(152, y + 18), (190, y + 12), (226, y + 22), (176, y + 40), (214, y + 44)]):
        if i:
            line(s, 152 + 18, y + 26, cx, cy, color="C9CCD0", w=0.75)
    label_box(s, 160, y + 18, 26, 16, [[("bid", {"bold": True})]], LIME, INK, size=7, radius=8, inset=1)
    for (cx, cy) in [(208, y + 10), (236, y + 26), (200, y + 44), (146, y + 44)]:
        box(s, cx - 4, cy - 4, 8, 8, fill=WHITE, line=DEEP, lw=1, shape=MSO_SHAPE.OVAL)
    text(s, 274, y + 21, 280, 34, [[("Score = priority · distance · deadline · energy · pad demand", {})],
                                   [("Bid only if E", {}), ("job", {"size": 6}), (" + E", {}), ("to pad", {"size": 6}),
                                    (" + reserve ≤ battery. Highest bid wins.", {})]], size=8.2, color=INK, spacing=1.04)
    # Own
    y = rows_y[2]
    stage_row(s, y, rh, "Own", DEEP, "epoch + lease 20 s · renew 5 s · depot fence", "Gray · Kleppmann")
    text(s, 140, y + 7, 22, 10, [[("A01", {"bold": True})]], size=6.6, color=INK)
    label_box(s, 162, y + 6, 52, 11, "epoch 1", TINT, DEEP, size=6.3, radius=3, inset=1)
    label_box(s, 216, y + 6, 26, 11, "silent", GREY, MUTED, size=6.0, radius=3, inset=1)
    label_box(s, 244, y + 6, 22, 11, "stop", GREY, MUTED, size=6.0, radius=3, inset=1)
    text(s, 140, y + 22, 22, 10, [[("A04", {"bold": True})]], size=6.6, color=INK)
    label_box(s, 216, y + 21, 50, 11, [[("epoch 2", {"bold": True})]], LIME, INK, size=6.3, radius=3, inset=1)
    text(s, 140, y + 36, 128, 20, [[("depot hands the parcel", {})], [("only to epoch 2", {"bold": True, "color": DEEP})]],
         size=6.6, color=INK, spacing=1.0)
    text(s, 274, y + 21, 280, 34, "The owner stops on its own clock when its lease lapses; the depot re-opens only after "
                                  "lease × 1.02 + 2 s, so drift never makes two live owners.", size=8.2, color=INK, spacing=1.04)
    # Fly
    y = rows_y[3]
    stage_row(s, y, rh, "Fly", INK, "aeropact_px4 · PX4 v1.16 offboard · uXRCE-DDS", "PX4 · Gazebo")
    picture(s, "gz_px4.jpg", 140, y + 6, 126, 46, focus=(0.5, 0.6), radius=4)
    text(s, 274, y + 21, 280, 34, [[("2.5D A* around buildings and no-fly zones; ", {}),
                                    ("safety supervisor (separation, 2 s geofence look-ahead) never imports coordination code.",
                                     {"bold": True})]], size=8.2, color=INK, spacing=1.04)
    # Recover
    y = rows_y[4]
    stage_row(s, y, rh, "Recover", RED, "probe → suspect → re-open → hand-off", "Hayashibara · Das")
    for i, (t, f, c) in enumerate([("probe", RTINT, RED), ("suspect", RTINT, RED), ("epoch+1", TINT, DEEP), ("hand-off", LIME, INK)]):
        label_box(s, 140 + i * 32, y + 10, 30, 14, [[(t, {"bold": True})]], f, c, size=5.8, radius=3, inset=1)
    text(s, 140, y + 30, 128, 24, [[("heartbeats carry max ", {}), ("remaining flight time", {"bold": True})]],
         size=6.6, color=INK, spacing=1.0)
    text(s, 274, y + 21, 280, 34, "Peers that should hear a drone probe before declaring it lost; its job re-opens at a "
                                  "higher epoch and a neighbour takes over.", size=8.2, color=INK, spacing=1.04)
    for yy in rows_y[1:]:
        down_arrow(s, 82, yy - 7)

    # radio layer under the flow
    box(s, 42, 446, 518, 32, fill=VTINT, radius=6)
    text(s, 50, 446, 506, 32, [[("UNDER EVERY STAGE  ", {"bold": True, "color": VIOLET, "size": 7.4}),
                                ("CRDT order board on every node · gossip every 1 s · HMAC-SHA256 mesh radio · "
                                 "planned-silence radio map · STRICT / QUORUM / OPTIMISTIC split rule", {})]],
         size=7.6, color=INK, anchor="m", spacing=1.0)

    # ---- findings: charts on a dark panel (right) ------------------------------
    PX, PW = 572, 346
    box(s, PX, 106, PW, 372, fill=INK, radius=10)
    text(s, PX + 14, 110, PW - 28, 16, [[("FINDINGS", {"bold": True, "color": LIME}),
                                        ("   1,260 runs · 30 seeds each · 95% confidence intervals", {"color": "BFC3C7", "size": 7})]],
         size=9, anchor="m")
    cx, cw = PX + 14, PW - 28
    # chart 1
    text(s, cx, 130, cw, 12, [[("On time after the hub is killed", {"bold": True}), ("   the auction gets there by double-delivering", {"size": 6.6, "color": "BFC3C7"})]], size=8.5, color=WHITE)
    bars = [("PACT", 72.5, LIME), ("Hub that never fails", 74.5, GREYBAR), ("Plain auction", 73.1, GREYBAR),
            ("Greedy nearest", 66.5, GREYBAR), ("Hub, killed", 44.7, "E0675D")]
    for i, (n, v, c) in enumerate(bars):
        hbar(s, cx, 147 + i * 13, cw, n, v, 100, c, f"{v}%", label_color=LIME if n == "PACT" else "D6D9DC")
    box(s, cx, 216, cw, 0.6, fill="4A4646")
    # chart 2
    text(s, cx, 221, cw, 12, [[("Double deliveries per run, 5-minute radio splits", {"bold": True})]], size=8.5, color=WHITE)
    bars2 = [("Plain auction · canyon", 17.8, "E0675D", "17.8"), ("Plain auction · coastal", 3.7, "E0675D", "3.7"),
             ("PACT · both maps", 0.0, LIME, "0")]
    for i, (n, v, c, t) in enumerate(bars2):
        hbar(s, cx, 238 + i * 13, cw, n, v, 18, c, t, lab_w=112, label_color=LIME if n.startswith("PACT") else "D6D9DC")
    box(s, cx, 281, cw, 0.6, fill="4A4646")
    # chart 3: planned silence
    text(s, cx, 286, cw, 12, [[("False failovers per run, canyon map", {"bold": True})]], size=8.5, color=WHITE)
    hbar(s, cx, 303, cw, "Fixed lease", 14.3, 15, GREYBAR, "14.3", label_color="D6D9DC")
    hbar(s, cx, 316, cw, "Planned silence", 6.3, 15, LIME, "6.3", label_color=LIME)
    text(s, cx, 329, cw, 12, [[("−56% false failovers · +5.6% deliveries · 30 seeds", {"bold": True})]], size=7.4, color=LIME)
    box(s, cx, 345, cw, 0.6, fill="4A4646")
    # stats
    sx = [cx, cx + cw / 2 + 4]
    text(s, sx[0], 351, cw / 2 - 4, 50, [[("9.7 s", {"bold": True, "size": 20, "color": LIME})],
                                         [("to re-claim a failed drone's parcel (others: 66–72 s)", {"size": 7, "color": "D6D9DC"})]],
         spacing=1.0)
    text(s, sx[1], 351, cw / 2 - 4, 50, [[("201 M", {"bold": True, "size": 20, "color": WHITE})],
                                         [("TLA+ states checked, 0 violations; no fencing: caught in 9 steps",
                                           {"size": 7, "color": "D6D9DC"})]], spacing=1.0)
    box(s, cx, 407, cw, 0.6, fill="4A4646")
    text(s, cx, 412, cw, 60, [[("STACK  ", {"bold": True, "color": LIME, "size": 7}),
                               ("ROS 2 Jazzy C++ lifecycle nodes · PX4 v1.16 SITL · uXRCE-DDS · Gazebo Harmonic · "
                                "TypeScript + Three.js simulator · 20 Hz deterministic replay · 1,000+ passing tests", {})]],
         size=7.6, color="E6E6E6", spacing=1.08)
    notes(s, "Research strip first: the six ideas PACT builds on. Then one parcel through the stack, top to bottom, "
             "each stage with its module and the research behind it. Then the findings, all measured: hub loss, "
             "radio splits, planned silence, recovery, and the TLA+ model check.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    inn = find_slide(prs, "What is the innovation in your idea?")
    tec = find_slide(prs, "Technical Details and Reports ")
    clear_body(inn); innovation(inn)
    clear_body(tec); technical(tec)
    keep = {inn.part, tec.part}
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) not in keep:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
