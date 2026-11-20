"""
Opening slide (KPIT 'Opening slide' layout): fill KPIT's four fields; right side = hero image, one-line promise,
three measured proof points.
    python build_s_title.py "<Sparkle Idea presentation template 2026-27.pptx>"
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Pt

import build_native as B
from build_native import DEEP, INK, LIME, MUTED, RED, TINT, VIOLET, WHITE, box, label_box, notes, picture, text

OUT_FILE = os.path.join(B.OUT, "PACT_title.pptx")


def opening(s):
    ph = sorted([p for p in s.placeholders], key=lambda p: p.top)
    vals = [
        ["Decentralized Multi-agent Coordination for Autonomous Logistics"],
        ["PACT: Partition-Aware Coordination for Transport"],
        ["PANGnovates · Saveetha Engineering College"],
        ["Nanda Kishor Suresh Priya: Team Lead & System Architect",
         "Ganesh Kumar T: Robotics & Simulation Engineer",
         "Aman Singh: Verification & Benchmarking Lead",
         "Paul Shervin P: Research & Documentation Lead",
         "Dr. Karthika R N: Project Guide / Mentor"],
    ]
    for p, lines in zip(ph, vals):
        l, t, h = p.left, p.top, p.height
        p.left, p.top, p.width, p.height = l, t, Pt(440), h
        tf = p.text_frame
        tf.text = lines[0]
        for ln in lines[1:]:
            tf.add_paragraph().text = ln
        for para in tf.paragraphs:
            for r in para.runs:
                r.font.size = Pt(13)
            para.space_after = Pt(2)
            pPr = para._p.get_or_add_pPr()
            pPr.set("marL", "0"); pPr.set("indent", "0")
            for old in pPr.findall(qn("a:buNone")) + pPr.findall(qn("a:buChar")):
                pPr.remove(old)
            pPr.insert(0, pPr.makeelement(qn("a:buNone"), {}))

    notes(s, "0:00-0:30. Who we are, the category, the team and our guide.")


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    op = prs.slides[1]
    opening(op)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is not op.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE)


if __name__ == "__main__":
    main()
