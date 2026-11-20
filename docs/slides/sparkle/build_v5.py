"""
v5 sample: the two slides that failed review, rebuilt with the new innovations and the real technical depth.
    python build_v5.py "<Sparkle Idea presentation template 2026-27.pptx>"
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
from build_sample import AMBER, answer, callout, chip, dot, guide, line, panel

OUT_FILE = os.path.join(B.OUT, "PACT_sample_v5.pptx")


def tag(s, x, y, w, t, color=INK, fill=GREY, h=13, size=7.2):
    """Stack tag: the real module / parameter doing this step."""
    label_box(s, x, y, w, h, [[(t, {"bold": True})]], fill, color, size=size, radius=3, inset=4, align="l")


# ------------------------------------------------------------------ innovation
def innovation(s):
    guide(s, "How is the idea innovative? Why is it best suited to the problem? What is unique in its "
             "functionality and performance?")
    answer(s, [("Removing the hub is the easy part. ", {}),
               ("It also removes the only thing that knew who owns each parcel.", {"color": DEEP})], size=16.5)

    # left: the scene, with callouts on the four things that make PACT different
    X, Y, W, H = 42, 90, 392, 214
    box(s, X - 2, Y - 2, W + 4, H + 4, fill=WHITE, line=LINE, radius=10)
    picture(s, "hero.png", X, Y, W, H, focus=(0.5, 0.45), radius=9)
    iw, ih = 2752, 1536
    vis_w = ih * W / H
    cl = (iw - vis_w) * 0.5

    def P(px, py):
        return X + (px - cl) / vis_w * W, Y + (py - 0.0) / ih * H

    callout(s, *P(960, 650), X + 6, Y + 150, 118, 36, "Hub dark", "no brain to lose", RED)
    callout(s, *P(1520, 430), X + W - 130, Y + 6, 124, 36, "Radio shadow", "silence is planned, not feared", VIOLET)
    callout(s, *P(2030, 860), X + W - 130, Y + 168, 124, 40, "Depot = the lock", "parcel leaves only for the newest epoch",
            DEEP, fill=TINT)
    callout(s, *P(1020, 420), X + 6, Y + 6, 118, 36, "Local auction", "neighbours only", DEEP)

    # left bottom: what most teams will build
    text(s, 42, 310, 392, 13, [[("WHAT MOST TEAMS WILL BUILD", {"bold": True})]], size=8.5, color=RED)
    rivals = [("Elect a new leader", "Still a brain: the fleet pauses to re-elect, and a cut-off group cannot work."),
              ("Auction with no fencing", "Survives the hub, but in a radio split two drones own one parcel: "
                                          "17.8 double deliveries per run, measured."),
              ("Greedy nearest job", "No priorities or deadlines: 80.6% on time after hub loss.")]
    for i, (t, d) in enumerate(rivals):
        y = 326 + i * 38
        box(s, 42, y, 392, 34, fill=RTINT, radius=6)
        text(s, 50, y + 1, 380, 33, [[(t + "  ", {"bold": True, "color": RED}), (d, {})]], size=9, color=INK,
             anchor="m", spacing=1.0)

    # right: what only PACT does
    RX, RW = 446, 472
    text(s, RX, 90, RW, 13, [[("WHAT ONLY PACT DOES", {"bold": True})]], size=8.5, color=DEEP)
    inn = [("The depot is the physical lock", "Epoch fencing applied to the parcel itself: it leaves the depot only for "
            "the highest epoch. No consensus round, no leader.", "0 double deliveries in 240 split runs", False),
           ("Planned silence", "The fleet learns its own radio-shadow map (a CRDT shared by gossip) and writes a lease "
            "long enough to cover the predicted silence.", "false failovers −56% · deliveries +5.6%", True),
           ("Zombie-stop on the drone's own clock", "A silent owner stops itself; the depot waits lease × 1.02 + 2 s, "
            "so clock drift can never create two live owners.", "0 zombie pickups, drift-tested", False),
           ("Failure proven by physics, not timeouts", "Every heartbeat carries max remaining flight time; peers probe "
            "before declaring a drone lost.", "re-claimed in 9.9 s vs 61.7–67.9 s", False),
           ("Formally model-checked", "TLA+ model of ownership under loss, partitions, crashes and drift: no double "
            "pickup in 201 M states. Remove fencing: caught in 9 steps.", "TLC: 201,334,513 states", True)]
    for i, (t, d, m, new) in enumerate(inn):
        y = 106 + i * 69
        box(s, RX, y, RW, 64, fill=LIME if new else WHITE, line=None if new else LINE, radius=8)
        if not new:
            box(s, RX, y, 4, 64, fill=DEEP)
        text(s, RX + 12, y + 4, RW - 150, 16, [[(t, {"bold": True})]], size=11, color=INK)
        if new:
            label_box(s, RX + RW - 56, y + 6, 46, 14, [[("NEW", {"bold": True})]], INK, LIME, size=7.5, radius=7)
        text(s, RX + 12, y + 21, RW - 24, 26, d, size=9, color=INK, spacing=1.02)
        label_box(s, RX + 12, y + 47, 250, 14, [[(m, {"bold": True})]], WHITE if new else TINT, DEEP, size=8.5,
                  radius=7, align="l", inset=6)
    notes(s, "Open with the hook: everyone will remove the hub; the hard part is ownership without a coordinator. "
             "Left: what most teams build and where it breaks. Right: the five things only PACT does, two of them new "
             "this week: planned silence (measured: false failovers -56%) and the TLA+ model check.")


# ------------------------------------------------------------------ technical
def technical(s):
    guide(s, "A brief overview of the research behind the idea; showcase analysis, findings or insights.")
    answer(s, [("From order to recovery: ", {}),
               ("the same ROS 2 stack on every drone, its own copy of the order board, nothing central.",
                {"color": DEEP})], size=13.5)
    ya, ha = 84, 118
    # Job intake ----------------------------------------------------------
    panel(s, 42, ya, 170, ha, "Job intake")
    tag(s, 48, ya + 19, 158, "aeropact_depot · TaskRecord", DEEP, TINT)
    box(s, 48, ya + 35, 100, 44, fill=GREY, radius=4)
    text(s, 51, ya + 36, 96, 43, [[("JOB ", {"color": MUTED}), ("J-0142", {"bold": True})],
                                  [("FROM ", {"color": MUTED}), ("Depot D1 → P7", {})],
                                  [("PRIORITY ", {"color": MUTED}), ("P1", {"bold": True, "color": RED}), (" · deadline", {})]],
         size=7.2, color=INK, spacing=1.0)
    chip(s, 152, ya + 36, 54, "P1 urgent", RED, WHITE)
    chip(s, 152, ya + 51, 54, "P2", "F3D9A6", AMBER)
    chip(s, 152, ya + 66, 54, "P3 low", GREY, MUTED)
    text(s, 48, ya + 82, 160, 34, "Only depots create jobs and hand off parcels. A new P1 job triggers an "
                                  "immediate re-auction.", size=7.6, color=SLATE, spacing=1.0)
    arrow(s, 213, ya + 52, 7, 9)
    # Onboard agent / auction --------------------------------------------
    panel(s, 222, ya, 300, ha, "Onboard agent · decides locally")
    tag(s, 228, ya + 19, 288, "aeropact_agent · ROS 2 lifecycle node (C++) · auction every 2 s", DEEP, TINT)
    text(s, 228, ya + 35, 80, 10, [[("INPUTS", {"bold": True})]], size=6.5, color=MUTED)
    for i, t in enumerate(["Position", "Battery (SoC)", "Board copy", "Heartbeats", "Shadow map"]):
        chip(s, 228, ya + 45 + i * 11, 74, t, VTINT if t == "Shadow map" else GREY, VIOLET if t == "Shadow map" else INK,
             bold=t == "Shadow map", size=6.4, h=10)
    arrow(s, 306, ya + 66, 8, 10, color=DEEP)
    label_box(s, 318, ya + 50, 66, 40, [[("bid score", {"bold": True})], [("priority · distance · deadline · energy · pad demand", {"size": 5.8})]],
              LIME, INK, size=8, radius=8, inset=3)
    arrow(s, 388, ya + 66, 8, 10, color=DEEP)
    text(s, 400, ya + 35, 112, 10, [[("DECIDES", {"bold": True})]], size=6.5, color=MUTED)
    for i, t in enumerate(["Score open jobs", "Check payload + energy", "Broadcast CLAIM (epoch+1)", "Back off if outbid"]):
        chip(s, 400, ya + 45 + i * 13, 116, t, TINT, DEEP, bold=False, size=6.8, h=11.5)
    label_box(s, 228, ya + 101, 288, 13, [[("bid only if  E", {}), ("job", {"size": 6}), (" + E", {}), ("to pad", {"size": 6}),
                                          (" + reserve ≤ battery   ·   −2 × dark-minutes for P1", {})]],
              INK, LIME, size=7.4, radius=6)
    arrow(s, 523, ya + 52, 7, 9)
    # Path planning + safety ---------------------------------------------
    panel(s, 532, ya, 186, ha, "Path planning + safety")
    tag(s, 538, ya + 19, 174, "2.5D A* · 250 m chunks · no-fly zones", DEEP, TINT)
    for gx in range(5):
        for gy in range(3):
            busy = (gx, gy) in ((1, 1), (2, 0), (3, 1))
            box(s, 540 + gx * 15, ya + 37 + gy * 15, 13, 13, fill="C9CCD0" if busy else GREY, radius=2)
    box(s, 570, ya + 37, 13, 13, fill=RTINT, line=RED, lw=0.75, radius=2)
    line(s, 546, ya + 80, 546, ya + 58, color=DEEP, w=1.4)
    line(s, 546, ya + 58, 591, ya + 58, color=DEEP, w=1.4)
    line(s, 591, ya + 58, 612, ya + 43, color=DEEP, w=1.4)
    dot(s, 546, ya + 81, DEEP, 6)
    dot(s, 612, ya + 43, DEEP, 6)
    text(s, 620, ya + 35, 94, 46, [[("Climb, cruise at one altitude, descend; replans around storms and closed zones",
                                     {})]], size=6.9, color=SLATE, spacing=1.0)
    tag(s, 538, ya + 86, 174, "aeropact_safety · separation · 2 s geofence", RED, RTINT)
    text(s, 538, ya + 101, 174, 14, [[("Isolated: ", {"bold": True, "color": RED}),
                                      ("never imports coordination code", {})]], size=7.2, color=INK)
    arrow(s, 719, ya + 52, 7, 9)
    # Mesh radio ----------------------------------------------------------
    panel(s, 728, ya, 190, ha, "Mesh radio", color=VIOLET)
    tag(s, 734, ya + 19, 178, "aeropact_radio · HMAC-SHA256 · UDP mesh", VIOLET, VTINT)
    nodes = [(752, ya + 48), (790, ya + 40), (784, ya + 76), (746, ya + 84)]
    for a in range(4):
        for b2 in range(a + 1, 4):
            if (a, b2) != (0, 2):
                line(s, *nodes[a], *nodes[b2], color=VIOLET, w=0.75)
    for (nx, ny) in nodes:
        box(s, nx - 6, ny - 6, 12, 12, fill=WHITE, line=VIOLET, lw=1.2, shape=MSO_SHAPE.OVAL)
    text(s, 804, ya + 35, 110, 66, [[("HEARTBEAT CARRIES", {"bold": True, "size": 6, "color": MUTED})],
                                    [("position · SoC · health", {})], [("max_endurance_s", {"bold": True, "color": RED})],
                                    [("acked epoch + lease", {"bold": True})], [("seq (replay-safe)", {})]],
         size=6.9, color=INK, spacing=0.98)
    text(s, 734, ya + 101, 178, 14, [[("Hardware: ", {"bold": True, "color": VIOLET}), ("ESP32-S3 (₹1,299) or Wi-Fi HaLow", {})]],
         size=7.2, color=INK)

    # Row B ---------------------------------------------------------------
    yb, hb = 208, 130
    panel(s, 42, yb, 196, hb, "Shared order board", color=VIOLET)
    tag(s, 48, yb + 19, 184, "CRDT replica on every node", VIOLET, VTINT)
    for i, (t, d) in enumerate([("GossipDelta", "every 1 s + full anti-entropy"), ("TaskRecord", "epoch · owner · lease_s · renew"),
                                ("Pad reservations", "OR-set, no pad server"), ("ShardLease", "safe claims while split"),
                                ("Radio map cells", "NEW · samples, dark counts")]):
        y = yb + 36 + i * 18
        box(s, 48, y, 184, 16, fill=WHITE if i < 4 else VTINT, line=LINE, radius=4)
        text(s, 53, y, 178, 16, [[(t + "  ", {"bold": True, "color": VIOLET}), (d, {})]], size=7.1, color=INK, anchor="m")
    # centre: simulator + flight stack
    box(s, 246, yb, 466, hb, fill=INK, radius=8)
    picture(s, "sim3d.png", 250, yb + 4, 280, hb - 8, focus=(0.42, 0.42), radius=6)
    picture(s, "gz_px4.jpg", 534, yb + 4, 174, 70, focus=(0.5, 0.6), radius=6)
    text(s, 534, yb + 76, 176, 52, [[("FLIGHT STACK", {"bold": True, "color": LIME, "size": 7})],
                                    [("aeropact_px4 → PX4 v1.16 offboard", {})],
                                    [("TrajectorySetpoint over uXRCE-DDS", {})],
                                    [("gripper grab / release via VehicleCommand", {})],
                                    [("Gazebo Harmonic · 20 Hz sim step", {})]], size=6.8, color=WHITE, spacing=1.0)
    label_box(s, 254, yb + hb - 22, 160, 14, [[("Browser simulator · TypeScript · Three.js", {"bold": True})]],
              INK, LIME, size=6.8, radius=4, inset=3, align="l")
    # fenced ownership
    panel(s, 720, yb, 198, hb, "Fenced ownership")
    tag(s, 726, yb + 19, 186, "lease 20 s · renew every 5 s · epoch fence", DEEP, TINT)
    text(s, 726, yb + 36, 40, 10, [[("OWNER", {"bold": True})]], size=6.3, color=MUTED)
    label_box(s, 760, yb + 36, 70, 12, "epoch 1 · lease", TINT, DEEP, size=6.5, radius=3, line=LIME, lw=0.75)
    label_box(s, 832, yb + 36, 44, 12, "silent", RTINT, RED, size=6.5, radius=3)
    label_box(s, 878, yb + 36, 36, 12, "stops", GREY, MUTED, size=6.5, radius=3)
    text(s, 726, yb + 52, 40, 10, [[("NEXT", {"bold": True})]], size=6.3, color=MUTED)
    label_box(s, 832, yb + 52, 82, 12, [[("epoch 2 claims", {"bold": True})]], LIME, INK, size=6.5, radius=3)
    text(s, 726, yb + 68, 186, 60, [[("Owner stops at its earliest write + lease (own clock). ", {}),
                                     ("Depot re-opens after lease × 1.02 + 2 s. ", {"bold": True}),
                                     ("Pickup granted only to the highest epoch; grant memory fences anything stale.", {})]],
         size=7.2, color=INK, spacing=1.02)

    # Row C ---------------------------------------------------------------
    yc, hc = 344, 98
    panel(s, 42, yc, 306, hc, "Planned silence · new", color=VIOLET, fill=VTINT)
    for i, (t, d) in enumerate([("Learn", "100 m cells · dark = no depot word for 3 s · sampled every 0.5 s"),
                                ("Share", "counters merged by max: a CRDT, rides on existing gossip"),
                                ("Forecast", "longest dark stretch on the route, at cruise speed"),
                                ("Lease", "lease = clamp(20, 1.25 × dark + 10, 90) s")]):
        y = yc + 20 + i * 15
        text(s, 50, y, 300, 14, [[(t + "  ", {"bold": True, "color": VIOLET}), (d, {})]], size=7.3, color=INK, anchor="m")
    label_box(s, 50, yc + 81, 290, 14, [[("canyon map, 30 seeds: false failovers 14.3 → 6.3 per run (−56%)", {"bold": True})]],
              VIOLET, WHITE, size=7.3, radius=6)
    panel(s, 356, yc, 330, hc, "Failure and recovery", color=RED)
    steps = [("Probe", "peers that should hear it ask around", RTINT, RED), ("Suspect", "phi-accrual + endurance bound", RTINT, RED),
             ("Re-open", "epoch 1 → 2, re-auction", TINT, DEEP), ("Hand-off", "depot → highest epoch", LIME, INK)]
    sw = 76
    for i, (t, d, f, c) in enumerate(steps):
        x = 362 + i * (sw + 5)
        label_box(s, x, yc + 22, sw, 40, [[(t, {"bold": True, "size": 8.5})], [(d, {"size": 6.4})]], f, c, radius=5, inset=3)
        if i < 3:
            arrow(s, x + sw - 1, yc + 38, 6, 8, color=RED if i < 1 else DEEP)
    label_box(s, 362, yc + 68, 318, 26, [[("re-claimed in 9.9 s ", {"bold": True, "size": 9}),
                                          ("(median)  vs  61.7–67.9 s for a hub that must time out first", {"size": 7.2})]],
              TINT, DEEP, radius=6, inset=4)
    panel(s, 694, yc, 224, hc, "When the radio splits", color=VIOLET)
    for i, (t, d) in enumerate([("STRICT", "claim only under a live shard lease"), ("QUORUM", "only while a majority is reachable"),
                                ("OPTIMISTIC", "≤ 1 low-priority claim, never P1")]):
        label_box(s, 700, yc + 21 + i * 17, 212, 14, [[(t + "  ", {"bold": True}), (d, {})]], VTINT, VIOLET, size=7,
                  radius=4, inset=3, align="l")
    text(s, 700, yc + 74, 212, 22, [[("Both sides keep delivering: ", {"bold": True}), ("0 double deliveries in 240 split runs", {})]],
         size=7.3, color=INK, spacing=1.0)

    # verified strip
    box(s, 42, 448, 876, 30, fill=INK, radius=8)
    text(s, 54, 448, 80, 30, [[("VERIFIED", {"bold": True})]], size=8.5, color=LIME, anchor="m")
    items = ["TLA+ / TLC: 201 M states, no double pickup", "1,000+ passing tests", "340 benchmark runs, 95% CIs",
             "same seed → same log hash"]
    w = (918 - 140 - 10) / len(items)
    for i, it in enumerate(items):
        if i:
            box(s, 140 + i * w, 456, 0.8, 14, fill="5A5A5A")
        text(s, 140 + i * w, 448, w, 30, it, size=8.3, color=WHITE, align="c", anchor="m")
    notes(s, "Walk the flow: depot job, local decision, path and safety, mesh radio; the shared board, the flight "
             "stack and fenced ownership; then the three things that happen when the world goes wrong: planned silence, "
             "failure recovery, radio splits. Close on what verifies it.")


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
