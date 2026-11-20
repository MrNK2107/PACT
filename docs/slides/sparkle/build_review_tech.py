"""Review deck: the three new Technical Details slides (architecture, validation, resources) in order."""
import os, shutil, sys
from pptx import Presentation
from pptx.oxml.ns import qn
import build_native as B
from build_native import add_continuation
from build_s_arch import arch
from build_s_validation import validation
from build_s_resources import resources

OUT_FILE = os.path.join(B.OUT, "PACT_tech_extra.pptx")
template = sys.argv[1] if len(sys.argv) > 1 else B.TEMPLATE
scratch = OUT_FILE + ".building.pptx"
shutil.copyfile(template, scratch)
prs = Presentation(scratch)
keep = []
for fn in (arch, validation, resources):
    sl = add_continuation(prs, "Technical Details and Reports ")
    fn(sl)
    keep.append(sl.part)
for el in list(prs.slides._sldIdLst):
    if prs.part.related_part(el.get(qn("r:id"))) not in keep:
        prs.part.drop_rel(el.get(qn("r:id")))
        prs.slides._sldIdLst.remove(el)
prs.save(scratch)
os.replace(scratch, OUT_FILE)
print("saved", OUT_FILE, len(prs.slides))
