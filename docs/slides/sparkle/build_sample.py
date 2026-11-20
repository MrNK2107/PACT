"""
Sample (v4 direction): two native, Canva-editable slides on the KPIT template.
  - "What is the innovation in your idea?"  answer-first, hero image with anchored callouts
  - "Technical Details and Reports"         dense order-to-recovery technical approach (SIH style)
No progress rail, no reading-order numbers; KPIT's guide question stays visible on each slide.

    python build_sample.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, RTINT, SLATE, TINT, VIOLET, VTINT, WHITE,
                          arrow, box, clear_body, find_slide, label_box, notes, picture, rgb, text)

AMBER = "B26A00"
OUT_FILE = os.path.join(B.OUT, "PACT_sample_v4.pptx")


def guide(s, question):
    """KPIT's own guide question, kept visible and quiet."""
    text(s, 42, 44, 876, 14, [[("KPIT asks  ", {"bold": True, "color": DEEP, "size": 7.5}),
                               (question, {"italic": True, "color": MUTED, "size": 8.5})]])


def answer(s, runs, size=17):
    text(s, 42, 58, 876, 26, [runs], size=size, color=INK, bold=True)


def line(s, x1, y1, x2, y2, color=INK, w=1.0, dash=False):
    c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Pt(x1), Pt(y1), Pt(x2), Pt(y2))
    c.line.color.rgb = rgb(color)
    c.line.width = Pt(w)
    if dash:
        ln = c.line._get_or_add_ln()
        d = ln.makeelement(qn("a:prstDash"), {"val": "dash"})
        ln.append(d)
    return c


def dot(s, x, y, color, d=9):
    o = box(s, x - d / 2, y - d / 2, d, d, fill=color, line=WHITE, lw=1.5, shape=MSO_SHAPE.OVAL)
    return o


def callout(s, ax, ay, lx, ly, w, h, head, body, color, fill=WHITE):
    """Dot on the image feature, leader line, and a label card."""
    tx = lx if lx > ax else lx + w
    line(s, ax, ay, tx, ly + h / 2, color=color, w=1.25)
    dot(s, ax, ay, color)
    box(s, lx, ly, w, h, fill=fill, line=color, lw=1.0, radius=6)
    box(s, lx, ly, 3, h, fill=color)
    text(s, lx + 8, ly + 2, w - 12, h - 4, [[(head, {"bold": True, "color": color, "size": 8.5})],
                                            [(body, {"size": 8, "color": INK})]], anchor="m", spacing=1.0)


# ------------------------------------------------------------------ innovation
def innovation(s):
    guide(s, "How is the idea innovative? Why is it best suited to the problem? What is unique in its "
             "functionality and performance?")
    answer(s, [("Every drone is its own dispatcher, and ", {}),
               ("no parcel can ever have two owners.", {"color": DEEP})])

    # hero with anchored callouts (left)
    X, Y, W, H = 42, 92, 470, 300
    box(s, X - 2, Y - 2, W + 4, H + 4, fill=WHITE, line=LINE, radius=10)
    picture(s, "hero.png", X, Y, W, H, focus=(0.5, 0.5), radius=9)
    # image-space -> slide-space for hero.png (2752 x 1536) cropped to W/H around the centre
    iw, ih = 2752, 1536
    vis_w = ih * W / H
    cl = (iw - vis_w) * 0.5

    def P(px, py):
        return X + (px - cl) / vis_w * W, Y + py / ih * H

    callout(s, *P(960, 650), X + 8, Y + 220, 150, 40, "Hub offline", "Nothing stalls: there is no brain to lose",
            RED)
    callout(s, *P(1020, 420), X + 8, Y + 10, 158, 40, "Local auction", "Drones bid over neighbour radio links",
            DEEP)
    callout(s, *P(1520, 420), X + W - 166, Y + 10, 158, 40, "Partition rule",
            "Each side knows what it may still claim", VIOLET)
    callout(s, *P(2030, 860), X + W - 166, Y + 232, 158, 50, "Fenced ownership",
            "Epoch + lease; the depot hands a parcel only to the newest epoch", DEEP, fill=TINT)

    # why it suits KPIT's problem (right)
    RX, RW = 528, 390
    text(s, RX, 92, RW, 14, [[("WHY IT FITS KPIT'S PROBLEM", {"bold": True})]], size=8, color=DEEP)
    rows = [("“If the brain loses connection, the entire fleet stops.”",
             "There is no brain. Every drone keeps its own copy of the order board, synced by gossip.",
             "86.3% on time after hub loss · no drop"),
            ("Radio splits the fleet into groups that cannot hear each other",
             "A fixed partition rule says what a cut-off group may still claim, so both sides keep working safely.",
             "76.9–88.6% on time during 5-min splits"),
            ("Two groups that cannot talk claim the same parcel",
             "Fenced ownership: a silent owner's lease expires, the job reopens at a higher epoch, the old owner must stop.",
             "0 double deliveries in 240 runs")]
    for i, (prob, ans, metric) in enumerate(rows):
        y = 110 + i * 78
        box(s, RX, y, RW, 72, fill=WHITE, line=LINE, radius=8)
        text(s, RX + 10, y + 5, RW - 20, 14, [[(prob, {"italic": True})]], size=8.5, color=RED)
        text(s, RX + 10, y + 20, RW - 20, 34, ans, size=9.5, color=INK, spacing=1.03)
        label_box(s, RX + 10, y + 52, 230, 15, [[(metric, {"bold": True})]], TINT, DEEP, size=8, radius=7,
                  align="l", inset=6)
    # the genuinely new part
    box(s, RX, 346, RW, 46, fill=LIME, radius=8)
    text(s, RX + 12, 348, RW - 24, 42, [[("What is genuinely new  ", {"bold": True, "size": 8, "color": INK})],
                                        [("Fenced ownership (epoch + lease + depot check) combined with a partition "
                                          "rule. Auctions alone deliver parcels twice; we measured 17.8 per run.",
                                          {"size": 9.5, "color": INK})]], anchor="m", spacing=1.02)

    # unique in performance (bottom strip, full width)
    tiles = [("86.3%", "on time after the hub dies", "central hub: 56.8%", DEEP),
             ("0", "double deliveries under 5-min radio splits", "plain auction: up to 17.8 per run", DEEP),
             ("9.9 s", "median to re-claim a failed drone's parcel", "central hub: 61.7–67.9 s", DEEP),
             ("76", "radio messages per drone per minute", "light enough for low-bandwidth mesh radios", VIOLET)]
    tw = (876 - 3 * 8) / 4
    for i, (n, d, sub, c) in enumerate(tiles):
        x = 42 + i * (tw + 8)
        box(s, x, 402, tw, 70, fill=WHITE, line=LINE, radius=8)
        box(s, x, 402, tw, 3, fill=c)
        text(s, x + 10, 408, tw - 20, 30, [[(n, {"bold": True})]], size=22, color=c)
        text(s, x + 10, 438, tw - 20, 32, [[(d, {"color": INK})], [(sub, {"size": 7.5, "color": MUTED})]],
             size=8.5, spacing=1.0)
    notes(s, "Answer first: every drone is its own dispatcher and no parcel can ever have two owners. "
             "Point at the picture: no hub, local auction, partition rule, fenced ownership at the depot. "
             "Then map KPIT's three failure modes to our answers, and close on the four measured numbers.")


# ------------------------------------------------------------------ technical approach
def panel(s, x, y, w, h, head, color=DEEP, fill=WHITE):
    box(s, x, y, w, h, fill=fill, line=LINE, radius=7)
    box(s, x, y, w, 16, fill=TINT if color == DEEP else (VTINT if color == VIOLET else RTINT), radius=7)
    box(s, x, y + 9, w, 7, fill=TINT if color == DEEP else (VTINT if color == VIOLET else RTINT))
    text(s, x + 7, y, w - 14, 16, [[(head.upper(), {"bold": True})]], size=7.5, color=color, anchor="m")


def chip(s, x, y, w, t, fill, color, size=7.5, h=13, bold=True):
    label_box(s, x, y, w, h, [[(t, {"bold": bold})]], fill, color, size=size, radius=6, inset=2)


def technical(s):
    guide(s, "A brief overview of the research behind the idea; showcase analysis, findings or insights.")
    answer(s, [("From order to recovery: ", {}),
               ("every drone runs the same logic on its own copy of the order board. Nothing central decides.",
                {"color": DEEP})], size=14)

    # Row A ---------------------------------------------------------------
    y0, h0 = 88, 112
    # Job intake
    panel(s, 42, y0, 168, h0, "Job intake")
    box(s, 50, y0 + 22, 98, 50, fill=GREY, radius=5)
    text(s, 54, y0 + 24, 92, 48, [[("JOB  ", {"color": MUTED}), ("J-0142", {"bold": True})],
                                  [("PICKUP  ", {"color": MUTED}), ("Depot D1", {})],
                                  [("DROP  ", {"color": MUTED}), ("Point P7", {})],
                                  [("PRIORITY  ", {"color": MUTED}), ("P1 · deadline", {"bold": True, "color": RED})]],
         size=7, color=INK, spacing=1.0)
    chip(s, 154, y0 + 24, 48, "P1 urgent", RED, WHITE)
    chip(s, 154, y0 + 41, 48, "P2", "F3D9A6", AMBER)
    chip(s, 154, y0 + 58, 48, "P3 low", GREY, MUTED)
    text(s, 50, y0 + 76, 154, 34, "Only depots create jobs and hand off parcels. A new P1 job triggers an instant "
                                  "re-auction.", size=7.5, color=SLATE, spacing=1.0)
    arrow(s, 212, y0 + 48, 8, 10)
    # Onboard agent
    panel(s, 222, y0, 300, h0, "Onboard agent · same code on every drone")
    text(s, 230, y0 + 20, 90, 12, [[("INPUTS", {"bold": True})]], size=6.5, color=MUTED)
    for i, t in enumerate(["Position", "Battery", "Own board copy", "Heartbeats"]):
        chip(s, 230, y0 + 32 + i * 15, 82, t, GREY, INK, bold=False, size=7)
    arrow(s, 318, y0 + 56, 10, 12, color=DEEP)
    label_box(s, 332, y0 + 40, 54, 42, [[("Local", {"bold": True})], [("decision", {})]], LIME, INK, size=8,
              radius=21)
    arrow(s, 390, y0 + 56, 10, 12, color=DEEP)
    text(s, 404, y0 + 20, 112, 12, [[("DECIDES", {"bold": True})]], size=6.5, color=MUTED)
    for i, t in enumerate(["Score open jobs", "Check payload + energy", "Broadcast CLAIM", "Fly, deliver, recharge"]):
        chip(s, 404, y0 + 32 + i * 15, 112, t, TINT, DEEP, bold=False, size=7)
    label_box(s, 230, y0 + 94, 286, 14, [[("claim only if  E", {}), ("job", {"size": 6}), (" + E", {}),
                                          ("to pad", {"size": 6}), (" + reserve ≤ battery", {})]],
              INK, LIME, size=7.5, radius=7)
    arrow(s, 524, y0 + 48, 8, 10)
    # Path planning
    panel(s, 534, y0, 180, h0, "Path planning")
    for gx in range(5):
        for gy in range(3):
            if (gx, gy) in ((1, 1), (2, 0), (3, 1)):
                box(s, 542 + gx * 17, y0 + 24 + gy * 17, 15, 15, fill="C9CCD0", radius=2)
            else:
                box(s, 542 + gx * 17, y0 + 24 + gy * 17, 15, 15, fill=GREY, radius=2)
    box(s, 576, y0 + 24, 15, 15, fill=RTINT, line=RED, lw=0.75, radius=2)
    line(s, 549, y0 + 65, 549, y0 + 48, color=DEEP, w=1.5)
    line(s, 549, y0 + 48, 566, y0 + 48, color=DEEP, w=1.5)
    line(s, 566, y0 + 48, 566, y0 + 82, color=DEEP, w=1.5, dash=True) if False else None
    line(s, 566, y0 + 48, 600, y0 + 48, color=DEEP, w=1.5)
    line(s, 600, y0 + 48, 627, y0 + 31, color=DEEP, w=1.5)
    dot(s, 549, y0 + 66, DEEP, 6)
    dot(s, 627, y0 + 31, DEEP, 7)
    text(s, 632, y0 + 22, 78, 60, [[("A* route", {"bold": True, "color": INK})],
                                   [("climb, cruise at one altitude around buildings and no-fly zones, descend", {})]],
         size=7, color=SLATE, spacing=1.0)
    text(s, 542, y0 + 80, 166, 30, [[("Local avoidance  ", {"bold": True, "color": INK}),
                                     ("keeps separation from drones and obstacles; can always brake in time", {})]],
         size=7, color=SLATE, spacing=1.0)
    arrow(s, 716, y0 + 48, 8, 10)
    # P2P network
    panel(s, 726, y0, 192, h0, "P2P fleet network", color=VIOLET)
    nodes = [(752, y0 + 40), (800, y0 + 30), (790, y0 + 72), (744, y0 + 82)]
    for a in range(len(nodes)):
        for b in range(a + 1, len(nodes)):
            if (a, b) != (0, 2):
                line(s, *nodes[a], *nodes[b], color=VIOLET, w=0.75)
    for (nx, ny) in nodes:
        box(s, nx - 7, ny - 7, 14, 14, fill=WHITE, line=VIOLET, lw=1.25, shape=MSO_SHAPE.OVAL)
    text(s, 816, y0 + 20, 98, 70, [[("SHARED IN HEARTBEATS", {"bold": True, "size": 6, "color": MUTED})],
                                   [("position", {})], [("intended path", {})], [("job · epoch · lease", {"bold": True})],
                                   [("battery", {})]], size=7, color=INK, spacing=0.98)
    text(s, 734, y0 + 92, 180, 18, [[("Own CRDT copy on every node · synced by gossip", {"bold": True})]],
         size=7, color=VIOLET)

    # Row B ---------------------------------------------------------------
    y1, h1 = 206, 136
    panel(s, 42, y1, 200, h1, "Dynamic re-routing")
    steps = [("Follow route", GREY, INK), ("Storm or zone closes", RTINT, RED), ("A* replans around it", TINT, DEEP),
             ("Delivered on time", LIME, INK)]
    for i, (t, f, c) in enumerate(steps):
        yy = y1 + 24 + i * 27
        label_box(s, 52, yy, 180, 20, t, f, c, size=8, radius=10, bold=True)
        if i < 3:
            text(s, 136, yy + 18, 14, 10, "↓", size=7, color=MUTED, align="c")
    # simulator view (centre, the visual anchor)
    box(s, 250, y1, 460, h1, fill=INK, radius=8)
    picture(s, "sim3d.png", 254, y1 + 4, 452, h1 - 26, focus=(0.42, 0.42), radius=6)
    text(s, 258, y1 + h1 - 20, 300, 16, [[("SIMULATOR VIEW  ", {"bold": True, "color": LIME}),
                                          ("live 3D in the browser · headless for tests", {"color": WHITE})]],
         size=7.5, anchor="m")
    text(s, 560, y1 + h1 - 20, 146, 16, [[("TypeScript · React · Three.js", {"color": "CFCFCF"})]], size=7,
         align="r", anchor="m")
    # conflict resolution
    panel(s, 718, y1, 200, h1, "Conflict resolution")
    line(s, 730, y1 + 46, 800, y1 + 46, color=DEEP, w=1.5)
    line(s, 765, y1 + 24, 765, y1 + 70, color=AMBER, w=1.5)
    dot(s, 765, y1 + 46, RED, 10)
    text(s, 806, y1 + 26, 106, 44, [[("Paths conflict at a crossing", {"bold": True, "color": INK})],
                                    [("lower priority yields, the other passes", {})]], size=7.5, color=SLATE,
         spacing=1.0)
    label_box(s, 728, y1 + 80, 180, 26, [[("conflict → lower fixed priority yields", {"bold": True})],
                                         [("same rule on every drone", {"size": 7})]], INK, LIME, size=7.5,
              radius=6)
    text(s, 728, y1 + 110, 180, 24, [[("Safety supervisor ", {"bold": True, "color": RED}),
                                      ("never imports coordination code", {})]], size=7.5, color=INK)

    # Row C ---------------------------------------------------------------
    y2, h2 = 348, 92
    panel(s, 42, y2, 432, h2, "Radio dead zone → link restored", color=VIOLET)
    states = [("Idle", "charged, waiting", GREY, INK), ("Claimed", "wins auction, lease starts", TINT, DEEP),
              ("Dead zone", "radio lost to fleet", VTINT, VIOLET), ("Works locally", "on its own board copy", TINT, DEEP),
              ("Link restored", "copies merge, agree", LIME, INK)]
    sw = 78
    for i, (t, d, f, c) in enumerate(states):
        x = 50 + i * (sw + 6)
        label_box(s, x, y2 + 22, sw, 36, [[(t, {"bold": True, "size": 8.5})], [(d, {"size": 6.5})]], f, c,
                  radius=6, inset=3)
        if i < 4:
            arrow(s, x + sw, y2 + 36, 6, 8, color=VIOLET)
    text(s, 50, y2 + 64, 120, 12, [[("PARTITION POLICY", {"bold": True})]], size=6.5, color=MUTED)
    for i, (t, d) in enumerate([("STRICT", "live lease on my side"), ("QUORUM", "majority reachable"),
                                ("OPTIMISTIC", "1 low-priority claim")]):
        label_box(s, 50 + i * 141, y2 + 75, 136, 13, [[(t + "  ", {"bold": True}), (d, {})]], VTINT, VIOLET,
                  size=7, radius=6, inset=2)
    panel(s, 482, y2, 436, h2, "Failure and recovery", color=RED)
    rec = [("Failure detected", "peers that expected to hear it report silence", RTINT, RED),
           ("Lease expires", "zombie-stop: the old owner must stop", RTINT, RED),
           ("Job reopens", "epoch 1 → 2, re-auctioned nearby", TINT, DEEP),
           ("Safe hand-off", "depot releases the parcel only to the highest epoch", LIME, INK)]
    rw = 102
    for i, (t, d, f, c) in enumerate(rec):
        x = 490 + i * (rw + 5)
        label_box(s, x, y2 + 22, rw, 46, [[(t, {"bold": True, "size": 8.5})], [(d, {"size": 6.8})]], f, c,
                  radius=6, inset=4)
        if i < 3:
            arrow(s, x + rw - 1, y2 + 40, 6, 8, color=RED if i == 0 else DEEP)
    text(s, 490, y2 + 72, 420, 16, [[("Measured: ", {"bold": True, "color": DEEP}),
                                     ("median 9.9 s from failure to re-claim (central hub: 61.7–67.9 s)", {})]],
         size=7.5, color=INK, anchor="m")

    # verified strip
    box(s, 42, 446, 876, 30, fill=INK, radius=8)
    text(s, 54, 446, 80, 30, [[("VERIFIED", {"bold": True})]], size=8.5, color=LIME, anchor="m")
    items = ["990+ passing tests", "100-run bench vs 3 baselines", "240-run sweep: 0 double deliveries",
             "Same seed, same log hash", "ROS 2 + PX4 SITL build"]
    w = (918 - 140 - 10) / len(items)
    for i, it in enumerate(items):
        if i:
            box(s, 140 + i * w, 454, 0.8, 14, fill="5A5A5A")
        text(s, 140 + i * w, 446, w, 30, it, size=8.5, color=WHITE, align="c", anchor="m")
    notes(s, "Walk the flow from a job entering at the depot to a failure being recovered. Point at the dead-zone "
             "row and the failure row: these are where PACT differs from a hub. Close on the verified strip.")


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
        part = prs.part.related_part(el.get(qn("r:id")))
        if part not in keep:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE, len(prs.slides), "slides")


if __name__ == "__main__":
    main()
