"""
Technical Details and Reports (2/2): validation. Field review (BEL, AisleZero SIH 2026, same team), the TLA+ model
check with its counterexamples, honest limits, and the reports / code as QR codes. Native shapes; QR codes only.
    python build_s_validation.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

import build_native as B
from build_native import (DEEP, GREY, INK, LIME, LINE, MUTED, RED, RTINT, TINT, VIOLET, VTINT, WHITE, add_continuation,
                          box, find_slide, label_box, notes, picture, text)
from build_sample import answer, guide, line

OUT_FILE = os.path.join(B.OUT, "PACT_validation.pptx")
SOFT = "F7F8F7"


def validation(s):
    guide(s, "A brief overview of the research behind the idea; showcase the analysis, findings or insights.")
    answer(s, [("Checked by engineers in the field and by a model checker, ", {}),
               ("not just by us.", {"color": DEEP})], size=16)

    # ---- field review ------------------------------------------------------------
    X, W = 42, 430
    text(s, X, 90, W, 13, [[("FIELD REVIEW", {"bold": True})]], size=8.5, color=DEEP)
    text(s, X, 104, W, 26, [[("Our SIH 2026 build (AisleZero, same team) ran these coordination ideas on real AMRs; "
                              "engineers at Bharat Electronics Ltd reviewed the workflow with us.", {})]],
         size=8.5, color=INK, spacing=1.05)
    experts = [("AK", "Alok Kumar", "BEL, Bengaluru Unit",
                "One robot or a blocked aisle must not stop the fleet.",
                "No hub: a silent drone's lease expires and a neighbour takes over in 9.7 s (median)."),
               ("KJ", "Karthikesh J G", "Founder & CEO, Karthikesh Robotics",
                "Existing hardware and safety controls should stay unchanged.",
                "PACT runs beside PX4; the safety supervisor never imports coordination code."),
               ("AC", "Avinash Chandak", "Research Staff, BEL Ghaziabad",
                "The WMS supplies tasks; robots should coordinate in real time locally.",
                "Depots publish jobs; drones decide among themselves over the mesh radio.")]
    for i, (ini, n, role, ins, resp) in enumerate(experts):
        y = 138 + i * 113
        box(s, X, y, W, 106, fill=WHITE, line=LINE, radius=8)
        label_box(s, X + 12, y + 12, 36, 36, [[(ini, {"bold": True})]], LIME, INK, size=11, radius=18, inset=0)
        text(s, X + 56, y + 10, 150, 36, [[(n, {"bold": True, "color": INK, "size": 10.5})],
                                         [(role, {"size": 7.4, "color": MUTED})]], spacing=1.0)
        text(s, X + 206, y + 10, W - 216, 40, [[("INSIGHT  ", {"bold": True, "size": 7, "color": VIOLET}),
                                               ("“" + ins + "”", {"italic": True})]], size=9.2, color=INK, spacing=1.02)
        box(s, X + 56, y + 56, W - 68, 0.75, fill=LINE)
        text(s, X + 56, y + 62, W - 68, 40, [[("PACT'S ANSWER  ", {"bold": True, "size": 7, "color": DEEP}),
                                              (resp, {})]], size=9.2, color=INK, spacing=1.04)

    # ---- model check -----------------------------------------------------------------
    MX, MW = 488, 430
    text(s, MX, 90, MW, 13, [[("FORMAL MODEL CHECK · TLA+ / TLC", {"bold": True})]], size=8.5, color=DEEP)
    box(s, MX, 106, MW, 196, fill=INK, radius=8)
    text(s, MX + 12, 112, MW - 24, 30, [[("Fenced ownership modelled with message loss, duplication and reordering, any "
                                          "radio partition, drone crashes, clock drift and any lease length.", {})]],
         size=8.3, color="E6E6E6", spacing=1.05)
    rows = [("Real protocol", "201,334,513 states explored", "0 violations", LIME),
            ("Remove the depot fence", "parcel handed out twice", "caught in 9 steps", "E0675D"),
            ("Ignore clock drift", "live owner overruled", "caught in 9 steps", "E0675D")]
    for i, (t, d, r, c) in enumerate(rows):
        y = 148 + i * 40
        box(s, MX + 12, y, MW - 24, 34, fill="34302F", radius=6)
        box(s, MX + 12, y, 4, 34, fill=c)
        text(s, MX + 24, y, 150, 34, [[(t, {"bold": True})]], size=9, color=WHITE, anchor="m")
        text(s, MX + 170, y, 140, 34, d, size=8.3, color="D6D9DC", anchor="m")
        text(s, MX + MW - 120, y, 104, 34, [[(r, {"bold": True})]], size=9, color=c, anchor="m", align="r")
    text(s, MX + 12, 270, MW - 24, 28, [[("Invariants: no parcel handed out twice; a parcel is never re-opened while its "
                                          "owner still holds a live lease. Bounded model; docs/formal/RESULTS.md.", {})]],
         size=7.4, color="BFC3C7", spacing=1.03)

    # ---- honest limits ---------------------------------------------------------------
    box(s, MX, 310, MW, 104, fill=RTINT, radius=8)
    text(s, MX + 12, 315, MW - 24, 12, [[("HONEST LIMITS", {"bold": True})]], size=8, color=RED)
    lims = ["Simulation and SITL only so far; real hardware is Phase 1.",
            "If a drone truly dies inside a forecast radio shadow, its parcel re-opens after up to ~94 s, not ~22 s.",
            "Battery crunch: 46.0% on time vs 47.0% for the hub (confidence intervals overlap).",
            "2 of 240 radio-split runs logged one loss of separation each."]
    text(s, MX + 12, 330, MW - 24, 82, [[("•  ", {"bold": True, "color": RED}), (l, {})] for l in lims], size=8.8,
         color=INK, after=3, spacing=1.03)

    box(s, MX, 420, MW, 56, fill=TINT, radius=8)
    text(s, MX + 12, 420, MW - 24, 56, [[("Prior art we extend: ", {"bold": True, "color": DEEP}),
                                         ("consensus-based auctions (CBBA), CRDTs, leases and fencing tokens. "
                                          "New in PACT: fenced ownership with a partition rule and planned silence.", {})]],
         size=8.4, color=INK, anchor="m", spacing=1.04)
    notes(s, "Field review first: three engineers' insights from our SIH 2026 build at BEL, and how PACT answers each. "
             "Then the model check: the real protocol holds across 201 M states; remove the fence or ignore drift and "
             "the checker finds a failure in 9 steps. Be upfront about the limits. Prior art closes the slide; the links are on the next one.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    sl = add_continuation(prs, "Technical Details and Reports ")
    validation(sl)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not sl.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
