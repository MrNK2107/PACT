"""
Assembles every APPROVED slide into one deck on the official KPIT template, in KPIT's order.
Add a slide here once it is approved.
    python build_final.py "<Sparkle Idea presentation template 2026-27.pptx>"
Output: out/INSP27001692_PANGnovates.pptx
"""
import os
import shutil
import sys

from pptx import Presentation
from pptx.oxml.ns import qn

import build_native as B
from build_native import clear_body, find_slide
from build_s_diff import diff
from build_s_future import future
from build_s_proto import proto
from build_s_title import opening
from build_v6 import innovation
from build_v7 import technical

OUT_FILE = os.path.join(B.OUT, "INSP27001692_PANGnovates.pptx")

# KPIT slide (title in the template) -> builder; None = keep the template slide as it is
APPROVED = [
    ("__opening__", opening),
    ("What is the innovation in your idea?", innovation),
    ("Key Differentiators:", diff),
    ("Prototype/Proof of concept", proto),
    ("Future Plans/potential next steps ", future),
    ("Technical Details and Reports ", technical),
    ("__ending__", None),
]


def main():
    template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
    scratch = OUT_FILE + ".building.pptx"
    shutil.copyfile(template, scratch)
    prs = Presentation(scratch)
    keep = []
    for title, build in APPROVED:
        if title == "__opening__":
            sl = prs.slides[1]
        elif title == "__ending__":
            sl = prs.slides[len(prs.slides) - 1]
        else:
            sl = find_slide(prs, title)
            clear_body(sl)
        if build:
            build(sl)
        keep.append(sl.part)
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) not in keep:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    prs.save(scratch)
    os.replace(scratch, OUT_FILE)
    print("saved", OUT_FILE, len(prs.slides), "slides")


if __name__ == "__main__":
    main()
