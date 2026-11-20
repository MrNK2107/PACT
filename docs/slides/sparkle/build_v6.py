"""
v6: slide 1 = v5 with uniform innovation cards and no empty band at the bottom;
    slide 2 = answers KPIT's guide in order: research -> how it works -> findings, with a disciplined palette
    (neutral cards; green = PACT's key facts, violet = network, red = failure).
    python build_v6.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, RTINT, SLATE, TINT, VIOLET, VTINT, WHITE,
                          arrow, box, clear_body, find_slide, label_box, notes, picture, text)
from build_sample import answer, callout, dot, guide, line

OUT_FILE = os.path.join(B.OUT, "PACT_sample_v6.pptx")
SOFT = "F7F8F7"   # card body tint


def label(s, x, y, w, t, color=DEEP, size=8.3):
    text(s, x, y, w, 12, [[(t.upper(), {"bold": True})]], size=size, color=color)


def card(s, x, y, w, h, fill=WHITE, edge=LINE):
    return box(s, x, y, w, h, fill=fill, line=edge, radius=7)


def state_graph(s, x, y, w, h):
    """Native mini diagram for the model check: a state graph fanning out, every leaf checked."""
    box(s, x, y, w, h, fill=SOFT, radius=6)
    root = (x + 16, y + h / 2)
    mids = [(x + 46, y + h * 0.25), (x + 46, y + h * 0.5), (x + 46, y + h * 0.75)]
    leaves = [(x + 76, y + h * (0.12 + 0.19 * k)) for k in range(5)]
    for m in mids:
        line(s, *root, *m, color="B9BDC2", w=0.75)
    for k, lf in enumerate(leaves):
        line(s, *mids[min(2, k * 3 // 5)], *lf, color="B9BDC2", w=0.75)
    for (px, py) in [root] + mids:
        box(s, px - 4, py - 4, 8, 8, fill=WHITE, line=DEEP, lw=1, shape=MSO_SHAPE.OVAL)
    for (px, py) in leaves:
        box(s, px - 3.5, py - 3.5, 7, 7, fill=LIME, shape=MSO_SHAPE.OVAL)
    label_box(s, x + w - 24, y + h / 2 - 10, 20, 20, [[("✓", {"bold": True})]], DEEP, WHITE, size=11, radius=10, inset=0)


# ------------------------------------------------------------------ slide 1
def innovation(s):
    guide(s, "How is the idea innovative? Why is it best suited to the problem? What is unique in its "
             "functionality and performance?")
    answer(s, [("Removing the hub is the easy part. ", {}),
               ("It also removes the only thing that knew who owns each parcel.", {"color": DEEP})], size=16.5)

    X, Y, W, H = 42, 90, 392, 226
    box(s, X - 2, Y - 2, W + 4, H + 4, fill=WHITE, line=LINE, radius=10)
    picture(s, "hero.png", X, Y, W, H, focus=(0.5, 0.45), radius=9)
    iw, ih = 2752, 1536
    vis_w = ih * W / H
    cl = (iw - vis_w) * 0.5

    def P(px, py):
        return X + (px - cl) / vis_w * W, Y + py / ih * H

    callout(s, *P(1020, 420), X + 6, Y + 6, 118, 36, "Local auction", "neighbours only", DEEP)
    callout(s, *P(1520, 430), X + W - 130, Y + 6, 124, 36, "Radio shadow", "silence is planned, not feared", VIOLET)
    callout(s, *P(960, 650), X + 6, Y + 160, 118, 36, "Hub dark", "no brain to lose", RED)
    callout(s, *P(2030, 860), X + W - 130, Y + 178, 124, 42, "Depot = the lock", "parcel leaves only for the newest epoch",
            DEEP, fill=TINT)

    label(s, 42, 324, 392, "What most teams will build", RED, 8.5)
    rivals = [("Elect a new leader", "Still a brain: the fleet pauses to re-elect, and a cut-off group cannot work."),
              ("Auction with no fencing", "Survives the hub, but in a radio split two drones own one parcel: "
                                          "17.8 double deliveries per run, measured."),
              ("Greedy nearest job", "No priorities or deadlines: 66.5% on time after hub loss.")]
    for i, (t, d) in enumerate(rivals):
        y = 340 + i * 47
        box(s, 42, y, 392, 42, fill=RTINT, radius=6)
        text(s, 52, y + 1, 376, 41, [[(t + "  ", {"bold": True, "color": RED}), (d, {})]], size=9.5, color=INK,
             anchor="m", spacing=1.02)

    RX, RW = 446, 472
    label(s, RX, 90, RW, "What only PACT does", DEEP, 8.5)
    inn = [("The depot is the physical lock", "Epoch fencing on the parcel itself: it leaves the depot only for the "
            "highest epoch. No leader, no consensus.", "0 double deliveries in 240 split runs"),
           ("Planned silence", "The fleet learns its own radio-shadow map and writes leases long enough "
            "to cover the predicted silence.", "false failovers −56% · deliveries +5.6%"),
           ("Zombie-stop on the drone's own clock", "A silent owner stops itself; the depot waits lease × 1.02 + 2 s, "
            "so drift never makes two live owners.", "0 zombie pickups, drift-tested"),
           ("Failure proven by physics, not timeouts", "Heartbeats carry max remaining flight time; peers probe before a "
            "drone is declared lost.", "re-claimed in 9.7 s vs 66–72 s"),
           ("Formally model-checked", "TLA+ model under loss, partitions, crashes and drift: no double pickup "
            "in 201 M states; without fencing, caught in 9 steps.", "TLC: 201,334,513 states, 0 violations")]
    ch, gap = 71, 5
    for i, (t, d, m) in enumerate(inn):
        y = 106 + i * (ch + gap)
        box(s, RX, y, RW, ch, fill=WHITE, line=LINE, radius=8)
        box(s, RX, y, 4, ch, fill=DEEP)
        text(s, RX + 12, y + 5, RW - 132, 16, [[(t, {"bold": True})]], size=11.5, color=INK)
        text(s, RX + 12, y + 23, RW - 132, 28, d, size=9.3, color=INK, spacing=1.02)
        vig = os.path.join(B.IMG, f"vig{i + 1}.png")
        if os.path.exists(vig):
            picture(s, f"vig{i + 1}.png", RX + RW - 112, y + 4, 104, ch - 8, radius=6)
        elif i == 4:
            state_graph(s, RX + RW - 112, y + 4, 104, ch - 8)
        label_box(s, RX + 12, y + ch - 18, 236, 14, [[(m, {"bold": True})]], TINT, DEEP, size=8.6, radius=7,
                  align="l", inset=6)
    notes(s, "Hook first: everyone will remove the hub; the hard part is ownership without a coordinator. "
             "Left: what most teams build and where it breaks. Right: the five things only PACT does, each measured.")


# ------------------------------------------------------------------ slide 2
def stage(s, x, y, w, h, name, tagtxt, color=INK):
    card(s, x, y, w, h, fill=WHITE)
    text(s, x + 8, y + 5, w - 16, 14, [[(name, {"bold": True})]], size=10.5, color=color)
    label_box(s, x + 8, y + 21, w - 16, 13, [[(tagtxt, {"bold": True})]], GREY, INK, size=6.9, radius=3, inset=4,
              align="l")


def technical(s):
    guide(s, "A brief overview of the research behind the idea; then showcase the analysis, findings or insights.")
    answer(s, [("Six proven ideas from distributed systems, ", {}),
               ("rebuilt for drones that lose radio, crash and drift.", {"color": DEEP})], size=14)

    # ---- 1. research ------------------------------------------------------
    label(s, 42, 82, 300, "The research we built on")
    refs = [("Market auctions", "CBBA · Choi, Brunet, How 2009", "local auction"),
            ("CRDTs", "Shapiro et al. 2011", "shared board, radio map"),
            ("Leases", "Gray, Cheriton 1989", "job ownership"),
            ("Fencing tokens", "Kleppmann 2017", "the depot lock"),
            ("φ-accrual + SWIM probes", "Hayashibara 2004 · Das 2002", "failure detection"),
            ("CAP theorem", "Brewer · Gilbert, Lynch 2002", "partition policy")]
    rw = (876 - 5 * 6) / 6
    for i, (t, a, u) in enumerate(refs):
        x = 42 + i * (rw + 6)
        card(s, x, 96, rw, 50, fill=SOFT)
        text(s, x + 7, 98, rw - 14, 48, [[(t, {"bold": True, "color": INK, "size": 10})],
                                         [(a, {"size": 7.4, "color": MUTED})],
                                         [("→ " + u, {"bold": True, "color": DEEP, "size": 8.4})]], spacing=1.05)

    # ---- 2. how it works: one flow ------------------------------------------
    label(s, 42, 152, 400, "How it works · the same ROS 2 stack on every drone")
    ys, hs = 166, 152
    sw = (876 - 4 * 14) / 5
    xs = [42 + i * (sw + 14) for i in range(5)]
    # Job in
    stage(s, xs[0], ys, sw, hs, "Job in", "aeropact_depot · TaskRecord")
    box(s, xs[0] + 8, ys + 40, sw - 16, 46, fill=SOFT, radius=4)
    text(s, xs[0] + 12, ys + 42, sw - 24, 44, [[("J-0142", {"bold": True}), ("  Depot D1 → P7", {})],
                                               [("priority ", {"color": MUTED}), ("P1", {"bold": True, "color": RED}),
                                                (" · deadline", {})],
                                               [("epoch 0 · unassigned", {"color": MUTED})]], size=7.6, color=INK, spacing=1.05)
    text(s, xs[0] + 8, ys + 92, sw - 16, 56, "Only depots create jobs and hand off parcels. A new P1 job triggers an "
                                             "immediate re-auction.", size=8, color=SLATE, spacing=1.03)
    # Decide
    stage(s, xs[1], ys, sw, hs, "Decide", "aeropact_agent · auction every 2 s")
    text(s, xs[1] + 8, ys + 40, sw - 16, 46, [[("Bid score: ", {"bold": True}), ("priority, distance, deadline, energy, "
                                                                                 "pad demand", {})],
                                              [("− 2 × predicted dark minutes for P1", {"color": VIOLET, "bold": True})]],
         size=7.8, color=INK, spacing=1.03)
    label_box(s, xs[1] + 8, ys + 88, sw - 16, 26, [[("bid only if", {"size": 6.6})],
                                                   [("E", {}), ("job", {"size": 5.8}), (" + E", {}), ("to pad", {"size": 5.8}),
                                                    (" + reserve ≤ battery", {})]], INK, LIME, size=7.6, radius=5, inset=3)
    text(s, xs[1] + 8, ys + 118, sw - 16, 30, "Highest bid wins; others back off. No controller.", size=7.8,
         color=SLATE, spacing=1.03)
    # Own
    stage(s, xs[2], ys, sw, hs, "Own", "epoch + lease 20 s · renew 5 s", color=DEEP)
    text(s, xs[2] + 8, ys + 40, 30, 10, [[("A01", {"bold": True})]], size=7, color=INK)
    label_box(s, xs[2] + 28, ys + 39, 60, 11, "epoch 1 · lease", TINT, DEEP, size=6.3, radius=3, inset=1)
    label_box(s, xs[2] + 90, ys + 39, 32, 11, "silent", GREY, MUTED, size=6.3, radius=3, inset=1)
    label_box(s, xs[2] + 124, ys + 39, sw - 132, 11, "stops", GREY, MUTED, size=6.3, radius=3, inset=1)
    text(s, xs[2] + 8, ys + 54, 30, 10, [[("A04", {"bold": True})]], size=7, color=INK)
    label_box(s, xs[2] + 94, ys + 53, sw - 102, 11, [[("epoch 2 claims", {"bold": True})]], LIME, INK, size=6.3, radius=3)
    text(s, xs[2] + 8, ys + 70, sw - 16, 78, [[("Owner stops at its earliest write + lease, on its own clock.", {})],
                                              [("Depot re-opens only after lease × 1.02 + 2 s.", {})],
                                              [("Pickup goes only to the highest epoch.", {"bold": True, "color": DEEP})]],
         size=7.8, color=INK, spacing=1.03, after=2)
    # Fly
    stage(s, xs[3], ys, sw, hs, "Fly", "aeropact_px4 · PX4 v1.16 offboard")
    picture(s, "gz_px4.jpg", xs[3] + 8, ys + 39, sw - 16, 44, focus=(0.5, 0.6), radius=4)
    text(s, xs[3] + 8, ys + 87, sw - 16, 62, [[("2.5D A* around buildings and no-fly zones", {})],
                                              [("TrajectorySetpoint over uXRCE-DDS; gripper via VehicleCommand", {})],
                                              [("Safety: separation + 2 s geofence look-ahead, isolated from coordination",
                                                {"bold": True})]], size=7.3, color=INK, spacing=1.0, after=1)
    # Recover
    stage(s, xs[4], ys, sw, hs, "Recover", "probe → suspect → re-open", color=RED)
    for i, (t, d) in enumerate([("Probe", "peers that should hear it ask around"),
                                ("Suspect", "φ-accrual + max endurance bound"),
                                ("Re-open", "epoch + 1, re-auctioned"),
                                ("Hand-off", "depot → highest epoch")]):
        y = ys + 39 + i * 22
        text(s, xs[4] + 8, y, sw - 16, 20, [[(t + "  ", {"bold": True, "color": RED if i < 2 else DEEP}), (d, {})]],
             size=7.5, color=INK, anchor="m", spacing=1.0)
    label_box(s, xs[4] + 8, ys + hs - 24, sw - 16, 18, [[("re-claimed in 9.9 s", {"bold": True})]], TINT, DEEP,
              size=8.3, radius=5)
    for i in range(4):
        arrow(s, xs[i] + sw + 3, ys + 70, 8, 10, color=MUTED)

    # spine: shared by every stage
    box(s, 42, 324, 876, 26, fill=VTINT, radius=6)
    text(s, 52, 324, 210, 26, [[("SHARED BY EVERY STAGE", {"bold": True})]], size=7.6, color=VIOLET, anchor="m")
    spine = ["CRDT order board on every node", "GossipDelta every 1 s", "HMAC-SHA256 mesh radio",
             "OR-set pad reservations", "ShardLease"]
    pw = (876 - 220) / len(spine)
    for i, t in enumerate(spine):
        text(s, 262 + i * pw, 324, pw, 26, t, size=7.6, color=INK, align="c", anchor="m")

    # when the world goes wrong (two new-ish mechanisms, neutral cards)
    card(s, 42, 356, 434, 86)
    text(s, 52, 360, 414, 14, [[("Radio shadows · planned silence", {"bold": True})]], size=10, color=INK)
    text(s, 52, 376, 414, 46, [[("Learn ", {"bold": True, "color": VIOLET}), ("100 m cells, dark = no depot word for 3 s  ", {}),
                                ("Share ", {"bold": True, "color": VIOLET}), ("counters merged by max (CRDT)  ", {}),
                                ("Forecast ", {"bold": True, "color": VIOLET}), ("longest dark stretch on the route  ", {}),
                                ("Lease ", {"bold": True, "color": VIOLET}), ("clamp(20, 1.25 × dark + 10, 90) s", {})]],
         size=8.8, color=INK, spacing=1.05)
    label_box(s, 52, 422, 300, 14, [[("canyon map, 30 seeds: false failovers 14.3 → 6.3 per run", {"bold": True})]],
              TINT, DEEP, size=7.8, radius=6, align="l", inset=6)
    card(s, 484, 356, 434, 86)
    text(s, 494, 360, 414, 14, [[("Radio splits · partition policy", {"bold": True})]], size=10, color=INK)
    for i, (t, d) in enumerate([("STRICT", "claim only under a live shard lease"), ("QUORUM", "only while a majority is reachable"),
                                ("OPTIMISTIC", "at most 1 low-priority claim, never P1")]):
        text(s, 494, 376 + i * 15, 414, 14, [[(t + "  ", {"bold": True, "color": VIOLET}), (d, {})]], size=8.8, color=INK)
    label_box(s, 494, 422, 300, 14, [[("240 split runs, 30 seeds: 0 double deliveries", {"bold": True})]],
              TINT, DEEP, size=7.8, radius=6, align="l", inset=6)

    # ---- 3. findings ---------------------------------------------------------
    box(s, 42, 448, 876, 30, fill=INK, radius=8)
    text(s, 54, 448, 80, 30, [[("FINDINGS", {"bold": True})]], size=8.5, color=LIME, anchor="m")
    items = ["86.3% on time after hub loss (hub: 56.8%)", "0 double deliveries", "TLA+: 201 M states, 0 violations",
             "1,000+ passing tests"]
    w = (918 - 140 - 10) / len(items)
    for i, it in enumerate(items):
        if i:
            box(s, 140 + i * w, 456, 0.8, 14, fill="5A5A5A")
        text(s, 140 + i * w, 448, w, 30, it, size=8.3, color=WHITE, align="c", anchor="m")
    notes(s, "Answer KPIT's guide in its order. Research: six established ideas we built on. How it works: one flow, "
             "job in to recovery, every stage tagged with the real module. Then the two hard cases (radio shadows, "
             "radio splits) and the findings.")


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
