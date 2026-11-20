"""
Prototype/Proof of concept: embedded demo video + what to watch for, and real stills that each prove one
capability (hub kill side by side, radio split, ROS 2 + Gazebo + PX4 build). No images reused from other slides.
    python build_s_proto.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, TINT, VIOLET, WHITE, box, clear_body, find_slide,
                          label_box, notes, picture, text)
from build_sample import answer, guide, line

OUT_FILE = os.path.join(B.OUT, "PACT_proto.pptx")
VIDEO = os.path.join(B.OUT, "pact_demo_60s.mp4")


def still(s, img, x, y, w, h, focus=(0.5, 0.5)):
    box(s, x - 2, y - 2, w + 4, h + 4, fill=INK, radius=7)
    picture(s, img, x, y, w, h, focus=focus, radius=6)


def proto(s):
    guide(s, "Share a video showcasing the prototype in operation, or pictures that clearly highlight its unique "
             "features and capabilities.")
    answer(s, [("It already runs: ", {}),
               ("the same protocol in a browser simulator and on PX4 autopilots in Gazebo.", {"color": DEEP})], size=15)

    # ---- left: the video and what to watch for ---------------------------------
    X, Y, W = 42, 92, 430
    H = W * 9 / 16
    box(s, X - 3, Y - 3, W + 6, H + 6, fill=INK, radius=8)
    s.shapes.add_movie(VIDEO, Pt(X), Pt(Y), Pt(W), Pt(H), poster_frame_image=os.path.join(B.IMG, "pr_poster.jpg"),
                       mime_type="video/mp4")
    text(s, X, Y + H + 8, W, 12, [[("WATCH FOR", {"bold": True, "color": DEEP}),
                                   ("   65 s demo · click to play", {"color": MUTED})]], size=8)
    cues = [("0:11", "Same city, seed and orders, run twice", INK),
            ("0:19", "The hub is killed; the central fleet stalls", RED),
            ("0:29", "PACT keeps going: no drop on time", DEEP),
            ("0:40", "Radio split: 0 double deliveries", VIOLET)]
    cy = Y + H + 26
    cw = (W - 3 * 6) / 4
    line(s, X + cw / 2, cy + 9, X + W - cw / 2, cy + 9, color=LINE, w=1.5)
    for i, (t, d, c) in enumerate(cues):
        x = X + i * (cw + 6)
        label_box(s, x + cw / 2 - 20, cy, 40, 18, [[(t, {"bold": True})]], c, WHITE, size=9, radius=9, inset=1)
        text(s, x, cy + 22, cw, 34, d, size=8.2, color=INK, align="c", spacing=1.02)
    text(s, X, cy + 60, W, 14, [[("Full 3-minute walkthrough and source: ", {"color": MUTED}),
                                 ("github.com/MrNK2107/PACT", {"bold": True, "color": DEEP,
                                                               "link": "https://github.com/MrNK2107/PACT"})]], size=8.4)

    # ---- right: stills, each proving one capability ------------------------------
    RX, RW = 488, 430
    hA = 128
    still(s, "pr_hubkill.jpg", RX, Y, RW, hA)
    label_box(s, RX + 8, Y + hA - 24, 150, 17, [[("CENTRAL HUB · 7 delivered", {"bold": True})]], RED, WHITE,
              size=7.6, radius=8, inset=2)
    label_box(s, RX + RW / 2 + 8, Y + hA - 24, 150, 17, [[("PACT · 18 delivered", {"bold": True})]], LIME, INK,
              size=7.6, radius=8, inset=2)
    text(s, RX, Y + hA + 5, RW, 28, [[("Hub killed, side by side. ", {"bold": True, "color": INK}),
                                      ("Same seed at 14:23 sim time: the central fleet is stuck at 7 deliveries, "
                                       "PACT has made 18 and keeps going.", {})]], size=8.6, color=INK, spacing=1.04)
    yB = Y + hA + 38
    wB = (RW - 10) / 2
    hB = 124
    still(s, "pr_split_full.jpg", RX, yB, wB, hB, focus=(0.5, 0.25))
    label_box(s, RX + 6, yB + 6, 104, 16, [[("RADIO SPLIT", {"bold": True})]], VIOLET, WHITE, size=7.4, radius=8, inset=2)
    text(s, RX, yB + hB + 5, wB, 40, [[("Both sides keep working. ", {"bold": True}),
                                       ("A cut-off group claims only under its own shard lease; 0 duplicates.", {})]],
         size=8.4, color=INK, spacing=1.04)
    still(s, "pr_gz_depot.jpg", RX + wB + 10, yB, wB, hB, focus=(0.45, 0.55))
    label_box(s, RX + wB + 16, yB + 6, 132, 16, [[("ROS 2 + GAZEBO + PX4", {"bold": True})]], INK, LIME, size=7.4,
              radius=8, inset=2)
    text(s, RX + wB + 10, yB + hB + 5, wB, 40, [[("The same protocol as robotics software: ", {"bold": True}),
                                                ("one ROS 2 container per drone, PX4 v1.16 autopilots in the loop.", {})]],
         size=8.4, color=INK, spacing=1.04)

    # ---- bottom: evidence it works ------------------------------------------------
    box(s, 42, 440, 876, 36, fill=TINT, radius=8)
    text(s, 54, 440, 120, 36, [[("TWO WORKING BUILDS", {"bold": True})]], size=8.4, color=DEEP, anchor="m")
    items = [("Browser simulator", "391 tests · 75/75 scenario checks"),
             ("AeroPACT", "692 tests · 9/9 acceptance · 4/4 PX4 SITL"),
             ("Every run", "replays exactly from its seed")]
    iw = (918 - 190 - 10) / 3
    for i, (t, d) in enumerate(items):
        if i:
            box(s, 190 + i * iw, 448, 0.8, 20, fill="CFE3BC")
        text(s, 190 + i * iw, 440, iw, 36, [[(t + "  ", {"bold": True, "color": INK}), (d, {})]], size=8.6, color=INK,
             align="c", anchor="m")
    notes(s, "Play the 65-second video and call out each cue: same city twice, the hub is killed at 0:19, PACT keeps "
             "going, then the radio split with zero duplicates. Then point at the stills: the side-by-side counters, "
             "both sides of the split delivering, and the same protocol running on PX4 autopilots in Gazebo.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    sl = find_slide(prs, "Prototype/Proof of concept")
    clear_body(sl)
    proto(sl)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not sl.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
