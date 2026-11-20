"""
Technical Details and Reports (architecture): workflow + architecture + tech stack in one native diagram.
Depot node | signed mesh radio | one drone's ROS 2 container (real lifecycle node names, topics, parameters),
a workflow rail that names the component doing each step, hardware mapping and the tech stack.
    python build_s_arch.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, RTINT, TINT, VIOLET, VTINT, WHITE, add_continuation,
                          box, label_box, notes, rgb, text)
from build_sample import answer, guide

OUT_FILE = os.path.join(B.OUT, "PACT_arch.pptx")
SOFT = "F7F8F7"


def arrow_line(s, x1, y1, x2, y2, color=INK, w=1.4, both=False, label=None, lx=None, ly=None):
    c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Pt(x1), Pt(y1), Pt(x2), Pt(y2))
    c.line.color.rgb = rgb(color)
    c.line.width = Pt(w)
    ln = c.line._get_or_add_ln()
    ln.append(ln.makeelement(qn("a:tailEnd"), {"type": "triangle", "w": "med", "len": "med"}))
    if both:
        ln.append(ln.makeelement(qn("a:headEnd"), {"type": "triangle", "w": "med", "len": "med"}))
    if label:
        text(s, lx, ly, 90, 10, [[(label, {"bold": True})]], size=6.2, color=color)
    return c


def node(s, x, y, w, h, name, pkg, color, fill=WHITE, lw=1.4):
    box(s, x, y, w, h, fill=fill, line=color, lw=lw, radius=6)
    text(s, x + 7, y + 4, w - 14, 12, [[(name, {"bold": True})]], size=8.6, color=INK)
    text(s, x + 7, y + 15, w - 14, 10, pkg, size=6.3, color=MUTED)


def bullets(s, x, y, w, items, size=7.2, color=INK, gap=11.5):
    for i, (t, d) in enumerate(items):
        text(s, x, y + i * gap, w, gap, [[(t, {"bold": True}), ("  " + d if d else "", {"color": MUTED})]],
             size=size, color=color, anchor="m")


def arch(s):
    guide(s, "A brief overview of the research behind the idea; showcase the analysis, findings or insights.")
    answer(s, [("One ROS 2 container per drone, one per depot, and a signed mesh radio between them. ", {}),
               ("Nothing else.", {"color": DEEP})], size=15)
    Y0, H0 = 90, 222

    # ---- depot node ----------------------------------------------------------------
    DX, DW = 42, 180
    box(s, DX, Y0, DW, H0, fill=TINT, line=DEEP, lw=1.2, radius=8)
    text(s, DX + 8, Y0 + 5, DW - 16, 12, [[("DEPOT NODE", {"bold": True})]], size=7.6, color=DEEP)
    node(s, DX + 8, Y0 + 20, DW - 16, 30, "depot", "aeropact_depot · lifecycle node", DEEP)
    bullets(s, DX + 10, Y0 + 56, DW - 20, [("Job intake", "TaskRecord, epoch 0"),
                                           ("Board copy", "CRDT replica"),
                                           ("Arbiter", "epoch fence + grant memory"),
                                           ("Pads", "OR-set reservations"),
                                           ("Observer", "re-open after lease×1.02+2 s")], size=7, gap=13)
    node(s, DX + 8, Y0 + 128, DW - 16, 30, "mesh_radio_bridge", "aeropact_radio", VIOLET)
    label_box(s, DX + 8, Y0 + 166, DW - 16, 48, [[("The depot is the lock", {"bold": True, "size": 8})],
                                                 [("A parcel leaves only for the highest valid epoch; anything stale "
                                                   "is fenced.", {"size": 6.8})]], WHITE, INK, radius=5, inset=5,
              align="l")

    # ---- mesh radio ---------------------------------------------------------------
    RX, RW = 234, 124
    box(s, RX, Y0, RW, H0, fill=VTINT, line=VIOLET, lw=1.2, radius=8)
    text(s, RX + 8, Y0 + 5, RW - 16, 12, [[("MESH RADIO", {"bold": True})]], size=7.6, color=VIOLET)
    msgs = [("Heartbeat", "1 s"), ("GossipDelta", "1 s + full sync"), ("CLAIM", "epoch + 1"), ("PickupReq", "→ grant"),
            ("Probe / Ack", "silent peer?"), ("Distress", "abort + hand-off"), ("Radio map", "dark cells")]
    for i, (m, d) in enumerate(msgs):
        y = Y0 + 21 + i * 21
        label_box(s, RX + 8, y, RW - 16, 18, [[(m, {"bold": True, "color": VIOLET}), ("  " + d, {"color": INK, "size": 6.3})]],
                  WHITE, INK, size=7.2, radius=4, inset=4, align="l")
    text(s, RX + 8, Y0 + 170, RW - 16, 48, [[("HMAC-SHA256 signed frames", {"bold": True})],
                                            [("UDP mesh · replay-safe seq · neighbours only", {"color": MUTED})]],
         size=6.8, color=INK, spacing=1.02)
    arrow_line(s, DX + DW, Y0 + 143, RX, Y0 + 143, color=VIOLET, both=True)

    # ---- drone node ---------------------------------------------------------------
    NX, NW = 370, 548
    box(s, NX, Y0, NW, H0, fill=SOFT, line=INK, lw=1.2, radius=8)
    text(s, NX + 8, Y0 + 5, 300, 12, [[("DRONE NODE · one ROS 2 component container", {"bold": True})]], size=7.6,
         color=INK)
    text(s, NX + NW - 200, Y0 + 5, 192, 12, "the same code on every drone", size=6.8, color=MUTED, align="r")
    # radio bridge
    node(s, NX + 8, Y0 + 22, 104, 40, "mesh_radio_bridge", "radio/tx · radio/rx", VIOLET)
    arrow_line(s, RX + RW, Y0 + 42, NX + 8, Y0 + 42, color=VIOLET, both=True)
    # coordinator
    CX, CY, CW, CH = NX + 124, Y0 + 22, 236, 112
    node(s, CX, CY, CW, CH, "coordinator", "aeropact_agent · aeropact_core (C++)", DEEP, fill=WHITE, lw=2)
    bullets(s, CX + 8, CY + 28, CW - 16, [("Board copy", "CRDT replica, gossip 1 s"),
                                          ("Auction", "bid every 2 s · energy check"),
                                          ("Ownership", "epoch + lease 20 s, renew 5 s"),
                                          ("Partition policy", "STRICT / QUORUM / OPTIMISTIC"),
                                          ("Failure detector", "φ-accrual + probes + endurance"),
                                          ("Radio map", "planned-silence leases")], size=6.9, gap=13.5)
    arrow_line(s, NX + 112, Y0 + 42, CX, Y0 + 42, color=VIOLET, both=True)
    # right column: flight_manager -> vehicle_interface -> PX4
    FX, FW = CX + CW + 12, NX + NW - (CX + CW + 12) - 8
    node(s, FX, CY, FW, 54, "flight_manager", "aeropact_agent", INK)
    text(s, FX + 7, CY + 27, FW - 14, 26, [[("hex-grid route planner · energy model · mission", {})]], size=6.6,
         color=INK, spacing=1.0)
    arrow_line(s, CX + CW, CY + 27, FX, CY + 27, color=DEEP)
    node(s, FX, CY + 62, FW, 60, "vehicle_interface", "aeropact_px4 · offboard arbiter", INK)
    text(s, FX + 7, CY + 88, FW - 14, 32, [[("TrajectorySetpoint at 20 Hz · gripper via VehicleCommand · never "
                                             "contests PX4 failsafes", {})]], size=6.3, color=INK, spacing=1.0)
    arrow_line(s, FX + FW / 2, CY + 54, FX + FW / 2, CY + 62, color=DEEP)
    label_box(s, FX, CY + 130, FW, 62, [[("PX4 v1.16 autopilot", {"bold": True, "size": 8.4})],
                                       [("on the flight controller · uXRCE-DDS link", {"size": 6.6})]], INK, LIME,
              radius=6, inset=4)
    arrow_line(s, FX + FW / 2, CY + 122, FX + FW / 2, CY + 130, color=INK, both=True)
    # safety supervisor under the coordinator, overriding the vehicle interface
    VX, VY, VW, VH = CX, Y0 + 146, CW, 68
    node(s, VX, VY, VW, VH, "safety_supervisor", "aeropact_safety · isolated from coordination", RED, fill=RTINT)
    text(s, VX + 7, VY + 28, VW - 14, 38, [[("Separation keeping and a 2 s geofence look-ahead. It never imports "
                                             "coordination or network code, so a protocol bug cannot disable it.", {})]],
         size=6.9, color=INK, spacing=1.02)
    arrow_line(s, VX + VW, VY + 20, FX, CY + 100, color=RED)
    text(s, VX + VW - 52, VY + 2, 50, 10, [[("override", {"bold": True})]], size=6.2, color=RED, align="r")
    text(s, NX + 8, Y0 + 70, 104, 64, [[("Every drone keeps its own board copy and decides alone.", {})]], size=7,
         color=MUTED, spacing=1.04)

    # ---- workflow rail: who does each step ----------------------------------------------
    text(s, 42, 318, 400, 12, [[("ONE JOB, END TO END · AND THE COMPONENT THAT DOES EACH STEP", {"bold": True})]],
         size=7.6, color=DEEP)
    steps = [("Job in", "depot", DEEP), ("Bid", "coordinator · auction", DEEP),
             ("Claim", "coordinator · epoch + 1", DEEP), ("Renew lease", "coordinator · every 5 s", DEEP),
             ("Fly", "flight_manager → PX4", INK), ("Pickup", "depot arbiter · checks epoch", DEEP),
             ("Deliver", "vehicle_interface · gripper", INK), ("If silent", "probe → re-open, epoch + 1", RED)]
    sw = (876 - 7 * 6) / 8
    for i, (t, d, c) in enumerate(steps):
        x = 42 + i * (sw + 6)
        box(s, x, 333, sw, 46, fill=WHITE, line=c, lw=1.2, radius=6)
        box(s, x, 333, sw, 4, fill=LIME if c != RED else RED)
        text(s, x + 6, 339, sw - 12, 14, [[(t, {"bold": True})]], size=9, color=INK)
        text(s, x + 6, 354, sw - 12, 24, d, size=6.6, color=MUTED, spacing=1.0)
        if i < 7:
            arrow_line(s, x + sw + 0.5, 356, x + sw + 5.5, 356, color=MUTED, w=1.2)

    # ---- hardware mapping ---------------------------------------------------------------
    box(s, 42, 386, 876, 40, fill=SOFT, line=LINE, radius=8)
    text(s, 52, 386, 92, 40, [[("ON EACH DRONE", {"bold": True})]], size=7.6, color=DEEP, anchor="m")
    hw = [("Raspberry Pi 5", "4× Cortex-A76 · 2.4 GHz · 4 GB: runs the ROS 2 container"),
          ("ESP32-S3 radio", "ESP-NOW / Wi-Fi mesh link (HaLow for range)"),
          ("PX4 flight controller", "PX4 v1.16, linked over uXRCE-DDS")]
    hwW = (918 - 150 - 10) / 3
    for i, (t, d) in enumerate(hw):
        if i:
            box(s, 150 + i * hwW, 394, 0.8, 24, fill=LINE)
        text(s, 156 + i * hwW, 386, hwW - 12, 40, [[(t, {"bold": True, "color": INK, "size": 8.6})],
                                                   [(d, {"size": 7, "color": MUTED})]], anchor="m", spacing=1.0)

    # ---- tech stack ---------------------------------------------------------------------
    box(s, 42, 432, 876, 44, fill=INK, radius=8)
    text(s, 52, 432, 80, 44, [[("TECH STACK", {"bold": True})]], size=8, color=LIME, anchor="m")
    stack = [("Robotics", "ROS 2 Jazzy · C++17 lifecycle nodes"), ("Autopilot", "PX4 v1.16 SITL · uXRCE-DDS"),
             ("Simulation", "Gazebo Harmonic · TypeScript + Three.js"), ("Verification", "vitest · colcon test · TLA+ / TLC")]
    stW = (918 - 140 - 10) / 4
    for i, (t, d) in enumerate(stack):
        if i:
            box(s, 140 + i * stW, 442, 0.8, 24, fill="5A5A5A")
        text(s, 146 + i * stW, 432, stW - 10, 44, [[(t, {"bold": True, "color": LIME, "size": 7.4})],
                                                   [(d, {"color": WHITE, "size": 8})]], anchor="m", spacing=1.02)
    notes(s, "How it is built. Left, a depot node: it creates jobs and is the lock on the parcel. Middle, the signed mesh "
             "radio and the messages on it. Right, one drone's ROS 2 container, the same on every drone: coordinator, "
             "flight manager, an isolated safety supervisor, and the PX4 interface. Then follow one job along the "
             "rail and name the component that does each step.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    sl = add_continuation(prs, "Technical Details and Reports ")
    arch(sl)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not sl.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
