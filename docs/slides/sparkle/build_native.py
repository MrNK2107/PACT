"""
KPIT Sparkle 2027 expert-review deck, built from native PowerPoint elements (text boxes, shapes, tables)
on the official template, so every word stays editable after importing into Canva.

    python build_native.py "<Sparkle Idea presentation template 2026-27.pptx>"

Writes out/INSP27001692_PANGnovates.pptx via a scratch file (a failed run never touches the last good deck).
Every number comes from results/summary.md, results/sweep/sweep.md, results/recovery.json, aeropact/results/summary.md
or the cost sources listed on slide 8.
"""
import copy
import os
import sys

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "img")
OUT = os.path.join(HERE, "out")
TEMPLATE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    r"~\Downloads\Sparkle Idea presentation template 2026-27.pptx")
FINAL = os.path.join(OUT, "INSP27001692_PANGnovates.pptx")
SCRATCH = os.path.join(OUT, "_building_native.pptx")

# palette (template theme: lime 78D200, deep green 428003, violet 753DFF; ink 231F20)
INK, SLATE, MUTED = "231F20", "464646", "5E636A"
LINE, GREY = "E4E6E8", "F1F2F2"
LIME, DEEP, TINT = "78D200", "428003", "F1FAE3"
VIOLET, VTINT = "753DFF", "F1ECFF"
RED, RTINT = "B3362D", "FBE9E7"
WHITE = "FFFFFF"
FONT = "Work Sans"

SECTIONS = ["Innovation", "Differentiators", "Prototype", "Future", "Evidence"]
TOTAL = 12


def rgb(h):
    return RGBColor.from_string(h)


# ---------------------------------------------------------------- primitives
def _strip_style(shape):
    st = shape._element.find(qn("p:style"))
    if st is not None:
        shape._element.remove(st)


def box(slide, x, y, w, h, fill=None, line=None, lw=1.0, radius=None, shape=None):
    kind = shape or (MSO_SHAPE.ROUNDED_RECTANGLE if radius is not None else MSO_SHAPE.RECTANGLE)
    s = slide.shapes.add_shape(kind, Pt(x), Pt(y), Pt(w), Pt(h))
    _strip_style(s)
    if radius is not None and kind == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = min(0.5, radius / min(w, h))
    if fill:
        s.fill.solid()
        s.fill.fore_color.rgb = rgb(fill)
    else:
        s.fill.background()
    if line:
        s.line.color.rgb = rgb(line)
        s.line.width = Pt(lw)
    else:
        s.line.fill.background()
    s.text_frame.text = ""
    return s


def text(slide, x, y, w, h, paras, size=11, color=SLATE, bold=False, align="l", anchor="t",
         inset=0, spacing=1.12, after=0, shape=None):
    """paras: str | list of paragraphs; a paragraph is str or list of runs (text, {opts})."""
    if shape is None:
        shape = slide.shapes.add_textbox(Pt(x), Pt(y), Pt(w), Pt(h))
    tf = shape.text_frame
    tf.word_wrap = True
    tf.auto_size = None
    for side in ("left", "right", "top", "bottom"):
        setattr(tf, f"margin_{side}", Pt(inset))
    tf.vertical_anchor = {"t": MSO_ANCHOR.TOP, "m": MSO_ANCHOR.MIDDLE, "b": MSO_ANCHOR.BOTTOM}[anchor]
    if isinstance(paras, str):
        paras = [paras]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = {"l": PP_ALIGN.LEFT, "c": PP_ALIGN.CENTER, "r": PP_ALIGN.RIGHT}[align]
        p.line_spacing = spacing
        p.space_after = Pt(after)
        runs = [(para, {})] if isinstance(para, str) else para
        for t, o in runs:
            r = p.add_run()
            r.text = t
            f = r.font
            f.name = FONT
            f.size = Pt(o.get("size", size))
            f.bold = o.get("bold", bold)
            f.italic = o.get("italic", False)
            f.color.rgb = rgb(o.get("color", color))
            if o.get("link"):
                r.hyperlink.address = o["link"]
    return shape


def label_box(slide, x, y, w, h, paras, fill, color=INK, size=11, bold=False, align="c", radius=6,
              line=None, inset=4, anchor="m", lw=1.0):
    s = box(slide, x, y, w, h, fill=fill, line=line, lw=lw, radius=radius)
    text(slide, 0, 0, 0, 0, paras, size=size, color=color, bold=bold, align=align, anchor=anchor,
         inset=inset, shape=s)
    return s


def picture(slide, path, x, y, w, h, focus=(0.5, 0.5), radius=None):
    """Place an image cropped to fill the box (no distortion)."""
    path = os.path.join(IMG, path)
    iw, ih = Image.open(path).size
    pic = slide.shapes.add_picture(path, Pt(x), Pt(y), Pt(w), Pt(h))
    ia, ba = iw / ih, w / h
    if ia > ba:  # too wide: crop left/right
        ex = 1 - ba / ia
        pic.crop_left = ex * focus[0]
        pic.crop_right = ex * (1 - focus[0])
    elif ia < ba:
        ex = 1 - ia / ba
        pic.crop_top = ex * focus[1]
        pic.crop_bottom = ex * (1 - focus[1])
    if radius:
        geom = pic._element.spPr.find(qn("a:prstGeom"))
        geom.set("prst", "roundRect")
        av = geom.find(qn("a:avLst"))
        if av is None:
            av = geom.makeelement(qn("a:avLst"), {})
            geom.append(av)
        gd = av.makeelement(qn("a:gd"), {"name": "adj", "fmla": f"val {int(radius / min(w, h) * 100000)}"})
        av.append(gd)
    return pic


def badge(slide, x, y, d, label, fill=LIME, color=INK, size=10):
    s = box(slide, x, y, d, d, fill=fill, shape=MSO_SHAPE.OVAL)
    text(slide, 0, 0, 0, 0, [[(label, {"bold": True})]], size=size, color=color, align="c", anchor="m",
         shape=s)
    return s


def arrow(slide, x, y, w, h, color=LIME):
    s = slide.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Pt(x), Pt(y), Pt(w), Pt(h))
    _strip_style(s)
    s.fill.solid()
    s.fill.fore_color.rgb = rgb(color)
    s.line.fill.background()
    return s


# ---------------------------------------------------------------- slide furniture
def rail(slide, active):
    """Progress rail, top right: where the judge is in the five KPIT sections."""
    x0, y, w, h, g = 566, 13, 68, 17, 3
    for i, name in enumerate(SECTIONS):
        x = x0 + i * (w + g)
        if i == active:
            label_box(slide, x, y, w, h, [[(f"{i + 1} {name}", {"bold": True})]], LIME, INK, size=7, radius=8, inset=1)
        elif i < active:
            label_box(slide, x, y, w, h, f"{i + 1} {name}", TINT, DEEP, size=7, radius=8, inset=1)
        else:
            label_box(slide, x, y, w, h, f"{i + 1} {name}", WHITE, MUTED, size=7, radius=8, line=LINE, lw=0.75, inset=1)


def takeaway(slide, line, sub=None):
    box(slide, 42, 52, 4, 26 if not sub else 34, fill=LIME)
    paras = [[(line, {"bold": True, "size": 17, "color": INK})]]
    if sub:
        paras.append([(sub, {"size": 10.5, "color": MUTED})])
    text(slide, 54, 50, 860, 40, paras, spacing=1.0)


def band(slide, label, items, y=448):
    box(slide, 42, y, 876, 30, fill=INK, radius=8)
    text(slide, 54, y, 150, 30, [[(label, {"bold": True})]], size=8.5, color=LIME, anchor="m")
    n = len(items)
    x0, w = 200, (918 - 200 - 10) / n
    for i, it in enumerate(items):
        if i:
            box(slide, x0 + i * w, y + 8, 0.8, 14, fill="5A5A5A")
        text(slide, x0 + i * w, y, w, 30, it, size=10, color=WHITE, align="c", anchor="m")


def pageno(slide, n):
    text(slide, 840, 500, 78, 16, f"{n:02d} / {TOTAL}", size=9, color=MUTED, align="r")


def notes(slide, t):
    slide.notes_slide.notes_text_frame.text = t


def clear_body(slide):
    """Remove the template's [GUIDE] placeholders and guide text boxes; keep the title."""
    for shp in list(slide.shapes):
        is_title = shp.is_placeholder and shp.placeholder_format.type == 1
        if not is_title:
            shp._element.getparent().remove(shp._element)


def find_slide(prs, title):
    for s in prs.slides:
        if s.shapes.title is not None and s.shapes.title.text_frame.text.strip() == title.strip():
            return s
    raise KeyError(title)


def layout(prs, name):
    for l in prs.slide_layouts:
        if l.name == name:
            return l
    raise KeyError(name)


def add_continuation(prs, title_text):
    """New slide with the same title, formatted exactly like the template's own titled slide."""
    src = find_slide(prs, title_text)
    s = prs.slides.add_slide(layout(prs, "Title with Text box"))
    clear_body(s)
    dst_title = s.shapes.title
    dst_title._element.remove(dst_title._element.txBody)
    dst_title._element.append(copy.deepcopy(src.shapes.title._element.txBody))
    return s


def move_slide(prs, slide, index):
    lst = prs.slides._sldIdLst
    for el in list(lst):
        if el.get(qn("r:id")) and prs.part.related_part(el.get(qn("r:id"))) is slide.part:
            lst.remove(el)
            lst.insert(index, el)
            return


# ---------------------------------------------------------------- slides
def s1_opening(prs, s):
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
        l, t, h = p.left, p.top, p.height  # inherited from the layout when the slide has no own xfrm
        p.left, p.top, p.width, p.height = l, t, Pt(450), h
        tf = p.text_frame
        tf.text = lines[0]
        for ln in lines[1:]:
            tf.add_paragraph().text = ln
        for para in tf.paragraphs:
            for r in para.runs:
                r.font.size = Pt(13)
            para.space_after = Pt(2)
    # hero + hook (KPIT: "You can add relevant content to the title slide")
    box(s, 536, 84, 384, 186, fill=WHITE, radius=14)
    picture(s, "hero.png", 540, 88, 376, 178, focus=(0.55, 0.45), radius=12)
    label_box(s, 528, 104, 118, 18, [[("SIMULATED · NOT A RENDER OF REAL HARDWARE", {})]], WHITE, MUTED,
              size=6, radius=9) if False else None
    text(s, 540, 276, 378, 70, [
        [("3:00", {"bold": True, "color": RED}), ("  the hub dies.   ", {}),
         ("5:00", {"bold": True, "color": VIOLET}), ("  the radio splits the fleet.", {})],
        [("5:40", {"bold": True, "color": RED}), ("  the drone carrying parcel ", {}),
         ("J-0142", {"bold": True, "color": DEEP}), (" goes silent.", {})],
        [("What happens to the parcel?", {"bold": True, "size": 15, "color": INK})],
    ], size=11.5, color=INK, spacing=1.15, after=2)
    # deck map
    text(s, 540, 420, 200, 12, [[("THE DECK IN FIVE STEPS", {"bold": True})]], size=7.5, color=DEEP)
    w, g = 73, 3.25
    for i, n in enumerate(SECTIONS):
        label_box(s, 540 + i * (w + g), 434, w, 20, [[(f"{i + 1} ", {"bold": True, "color": DEEP}), (n, {})]],
                  WHITE, INK, size=7.5, radius=10, line=LINE, inset=1)
    notes(s, "0:00-0:45. Who we are. Then ask the hook: the hub dies, the radio splits, the drone carrying "
             "parcel J-0142 goes silent. What happens to the parcel? The rest of the deck answers it.")


def s2_problem(prs, s):
    rail(s, 0)
    takeaway(s, "When the central brain goes dark, today's fleets stop. PACT keeps flying.")
    # quote
    box(s, 42, 94, 4, 50, fill=RED)
    text(s, 54, 92, 410, 56, [
        [("“Relying on a single central controller is a major risk. If the ‘brain’ loses connection, "
          "the entire fleet stops.”", {"italic": True, "color": INK, "size": 12})],
        [("KPIT Sparkle 2027 problem statement", {"size": 8.5, "color": MUTED})]], spacing=1.1)
    rows = [("1", "Single point of failure", "One hub assigns every job. If it fails, every drone goes idle."),
            ("2", "Radio partitions", "Buildings and weather split the fleet into groups that cannot hear each other."),
            ("3", "Double dispatch", "Two groups that cannot talk both claim the same parcel.")]
    for i, (n, t, d) in enumerate(rows):
        y = 158 + i * 54
        box(s, 42, y, 422, 48, fill=RTINT, radius=8)
        badge(s, 52, y + 12, 24, n, fill=RED, color=WHITE, size=10)
        text(s, 86, y + 6, 370, 40, [[(t, {"bold": True, "color": RED, "size": 12})], [(d, {})]],
             size=10.5, color=SLATE, spacing=1.05)
    # hero stat
    box(s, 42, 324, 422, 112, fill=WHITE, line=LINE, radius=10)
    text(s, 56, 330, 150, 60, [[("−34%", {"bold": True, "size": 40, "color": RED})]])
    text(s, 200, 336, 256, 60, [[("on-time deliveries lost", {"bold": True, "color": INK, "size": 12.5})],
                                [("the moment a hub-run fleet's hub dies: 86.3% → 56.8%", {})]], size=10.5)
    text(s, 56, 392, 400, 40, [[("Measured in our 100-run benchmark (5 seeds × 900 s). "
                                  "PACT's on-time rate in the same test: 86.3%, no drop.", {})]],
         size=9.5, color=MUTED)
    # image
    box(s, 480, 92, 438, 344, fill=WHITE, line=LINE, radius=12)
    picture(s, "hero.png", 484, 96, 430, 336, focus=(0.55, 0.4), radius=10)
    label_box(s, 494, 396, 132, 30, [[("HUB OFFLINE  ", {"bold": True, "color": RED, "size": 8}),
                                      ("drones still work", {"size": 8.5})]], WHITE, INK, radius=8, line=LINE)
    label_box(s, 636, 396, 132, 30, [[("RADIO SPLIT  ", {"bold": True, "color": VIOLET, "size": 8}),
                                      ("both sides deliver", {"size": 8.5})]], WHITE, INK, radius=8, line=LINE)
    label_box(s, 778, 396, 130, 30, [[("NEIGHBOURS  ", {"bold": True, "color": DEEP, "size": 8}),
                                      ("radio range only", {"size": 8.5})]], WHITE, INK, radius=8, line=LINE)
    band(s, "PACT IN ONE LINE", ["Every drone is its own dispatcher", "No parcel can have two owners",
                                 "Works through radio splits"])
    pageno(s, 2)
    notes(s, "0:45-2:00. Read KPIT's own sentence. Three ways a hub-run fleet breaks. The red number is ours, "
             "measured: the hub fleet loses a third of its on-time deliveries when the hub dies; PACT loses none.")


def s3_story(prs, s):
    rail(s, 0)
    takeaway(s, "Follow parcel J-0142: three failures, one delivery.",
             "An illustrated walk-through of the protocol. Every number in this deck is measured.")
    steps = [
        ("0:00", "Claim", LIME, INK, "story1.png",
         [("A01 wins the local radio auction for J-0142 and owns it under ", {}), ("epoch 1", {"bold": True}),
          (", with a lease it renews by heartbeat.", {})], "Local auction", TINT, DEEP),
        ("3:00", "Hub dies", RED, WHITE, "story2.png",
         [("Nothing stalls. Every drone keeps ", {}), ("its own copy", {"bold": True}),
          (" of the order board and syncs it with neighbours by gossip.", {})], "Shared order board (CRDT)", TINT, DEEP),
        ("5:00", "Radio split", VIOLET, WHITE, "story3.png",
         [("Two groups can't hear each other. A ", {}), ("fixed partition rule", {"bold": True}),
          (" says what each side may still claim, so they never fight.", {})], "Partition policy", VTINT, VIOLET),
        ("5:40", "A01 goes silent", RED, WHITE, "story4.png",
         [("Its lease expires. A04 claims at ", {}), ("epoch 2", {"bold": True}),
          (". The depot refuses epoch 1 and hands the parcel only to A04.", {})], "Fenced ownership · core novelty",
         LIME, INK),
    ]
    w, g = 207, 16.0
    for i, (t, name, cf, cc, img, body, mech, mf, mc) in enumerate(steps):
        x = 42 + i * (w + g)
        label_box(s, x, 98, w, 20, [[(f"{i + 1}  ", {"bold": True}), (t + "  ", {"bold": True}), (name, {})]],
                  cf, cc, size=10, radius=10, align="l", inset=8)
        box(s, x, 122, w, 130, fill=WHITE, line=LINE, radius=8)
        picture(s, img, x + 2, 124, w - 4, 126, radius=7)
        text(s, x + 2, 258, w - 4, 70, [body], size=10, color=SLATE, spacing=1.08)
        label_box(s, x, 330, w, 20, mech, mf, mc, size=9, bold=True, radius=10)
        if i < 3:
            arrow(s, x + w + 3, 178, 10, 14, color=LIME)
    box(s, 42, 360, 876, 76, fill=TINT, radius=10)
    text(s, 58, 366, 330, 64, [[("Delivered exactly once", {"bold": True, "size": 20, "color": DEEP})],
                               [("no hub, no stall, no duplicate", {"size": 11, "color": INK})]], anchor="m")
    text(s, 400, 368, 160, 60, [[("9.9 s", {"bold": True, "size": 26, "color": DEEP})],
                                [("median from a drone failing to its parcel being re-claimed", {"size": 8.5})]],
         color=SLATE)
    text(s, 572, 368, 340, 60, [[("vs 61.7–67.9 s", {"bold": True, "size": 16, "color": RED})],
                                [("for a central hub that has to time out first (drone-failure scenario, 8 seeds)",
                                  {"size": 8.5})]], color=SLATE)
    band(s, "HELD IN EVERY RUN", ["0 double deliveries", "0 zombie pickups", "Same seed → same event log"])
    pageno(s, 3)
    notes(s, "2:00-4:00. Tell the story left to right; each frame introduces one idea. Spend time on frame 4: "
             "epoch + lease + depot check is our core novelty. Then the result: delivered once, 9.9 s median recovery.")


def s4_diff(prs, s):
    rail(s, 1)
    takeaway(s, "Same city, same faults, same seeds: only PACT never stalls and never double-delivers.")
    rows = [("Works with no central hub", "N", "Y", "Y", "Y"),
            ("Keeps delivering after hub loss", "N", "Y", "Y", "Y"),
            ("Never delivers a parcel twice", "Y", "Y", "N", "Y"),
            ("Respects priorities and deadlines", "Y", "N", "Y", "Y"),
            ("Safe rule for cut-off groups", "–", "N", "N", "Y")]
    hdr = ["Same maps, faults and seeds", "Central hub", "Greedy nearest", "Plain auction", "PACT (ours)"]
    tx, ty, tw = 42, 92, 520
    cw = [190, 82, 82, 82, 84]
    rh = 26
    tbl = s.shapes.add_table(len(rows) + 2, 5, Pt(tx), Pt(ty), Pt(tw), Pt(rh * (len(rows) + 2))).table
    tblPr = tbl._tbl.tblPr
    for a in ("firstRow", "bandRow"):
        tblPr.set(a, "0")
    st = tblPr.find(qn("a:tableStyleId"))
    if st is not None:
        tblPr.remove(st)
    for j, wdt in enumerate(cw):
        tbl.columns[j].width = Pt(wdt)

    def cell(i, j, val, fill, color, bold=False, size=10, align="c"):
        c = tbl.cell(i, j)
        c.fill.solid()
        c.fill.fore_color.rgb = rgb(fill)
        c.margin_left = c.margin_right = Pt(6)
        c.margin_top = c.margin_bottom = Pt(2)
        c.vertical_anchor = MSO_ANCHOR.MIDDLE
        text(s, 0, 0, 0, 0, [[(val, {"bold": bold})]], size=size, color=color, align=align, shape=c)

    for j, h in enumerate(hdr):
        cell(0, j, h, TINT if j == 4 else WHITE, DEEP if j == 4 else (MUTED if j == 0 else INK), bold=j > 0,
             size=8.5 if j == 0 else 10, align="l" if j == 0 else "c")
    sym = {"Y": ("✓ Yes", DEEP), "N": ("✗ No", RED), "–": ("n/a", MUTED)}
    for i, r in enumerate(rows, start=1):
        cell(i, 0, r[0], WHITE if i % 2 else "FAFAFA", INK, align="l", size=10)
        for j in range(1, 5):
            v, c = sym[r[j]]
            cell(i, j, v, TINT if j == 4 else (WHITE if i % 2 else "FAFAFA"), c, bold=True, size=10)
    last = len(rows) + 1
    cell(last, 0, "On time after the hub is killed", WHITE, INK, bold=True, align="l", size=10)
    for j, (v, c) in enumerate([("56.8%", RED), ("80.6%", MUTED), ("83.4%", MUTED), ("86.3%", DEEP)], start=1):
        cell(last, j, v, TINT if j == 4 else WHITE, c, bold=True, size=13)
    for row in tbl.rows:
        row.height = Pt(rh)
    text(s, 42, 280, 520, 34, [[("Plain auction", {"bold": True}),
                                (" = PACT's own auction with the fencing removed, so it isolates what fencing adds. "
                                 "100-run benchmark: 4 scenarios × 5 systems × 5 seeds × 900 s, 95% confidence intervals.",
                                 {})]], size=8.5, color=MUTED)
    box(s, 42, 320, 520, 116, fill=VTINT, radius=10)
    text(s, 56, 326, 300, 14, [[("CONFIRMED IN A SECOND, INDEPENDENT BUILD", {"bold": True})]], size=8,
         color=VIOLET)
    text(s, 56, 342, 500, 20, "ROS 2 + Gazebo (AeroPACT), hub killed, 5 seeds per system", size=9.5, color=MUTED)
    text(s, 56, 362, 250, 60, [[("20.2%", {"bold": True, "size": 26, "color": RED})],
                               [("central hub, on time", {"size": 10})]], color=INK)
    text(s, 250, 362, 300, 60, [[("66.8–68.5%", {"bold": True, "size": 26, "color": DEEP})],
                                [("PACT, on time · 0% duplicates · invariants held in every run", {"size": 10})]],
         color=INK)
    stats = [("NO SINGLE POINT OF FAILURE", "86.3%", "56.8%", "on time after the hub dies: PACT vs a central hub",
              "PACT keeps 20.0 deliveries per run; the hub fleet falls to 7.6"),
             ("NEVER DELIVER TWICE", "0", "17.8", "double deliveries per run under 5-minute radio splits",
              "240-run sweep, 30 seeds; plain auction in downtown radio canyons"),
             ("FAST RECOVERY", "9.9 s", "61.7–67.9 s", "from a drone failing to its parcel being re-claimed",
              "median, drone-failure scenario: PACT vs the hub's timeout")]
    for i, (k, a, b, d, sub) in enumerate(stats):
        y = 92 + i * 117
        box(s, 578, y, 340, 109, fill=WHITE, line=LINE, radius=10)
        box(s, 578, y, 6, 109, fill=LIME)
        text(s, 594, y + 8, 320, 14, [[(k, {"bold": True})]], size=8, color=DEEP)
        aw = max(30, int(len(a) * 17.5))
        text(s, 594, y + 20, aw + 6, 40, [[(a, {"bold": True, "size": 28, "color": DEEP})]])
        text(s, 594 + aw + 8, y + 32, 22, 20, [[("vs", {"size": 11, "color": MUTED})]])
        text(s, 594 + aw + 30, y + 27, 200, 30, [[(b, {"bold": True, "size": 18, "color": RED})]])
        text(s, 594, y + 62, 318, 44, [[(d, {"color": INK, "size": 10})], [(sub, {"size": 8.5, "color": MUTED})]],
             spacing=1.05)
    band(s, "BUILT LIKE VEHICLE SOFTWARE", ["Same seed, same log", "Safety layer isolated",
                                             "ROS 2 lifecycle nodes + PX4", "990+ passing tests"])
    pageno(s, 4)
    notes(s, "4:00-5:30. Four systems on the same seeds. Read the PACT column, then the three numbers. "
             "Point out the plain auction: it is our own auction without fencing, so the 17.8 duplicates are what "
             "fencing removes. Then the second build in ROS 2 confirms the same result.")


def s5_video(prs, s):
    rail(s, 2)
    takeaway(s, "Watch it: the same city and seed, a central hub on the left, PACT on the right.")
    vx, vy, vw = 42, 92, 560
    vh = vw * 9 / 16
    box(s, vx - 3, vy - 3, vw + 6, vh + 6, fill=INK, radius=8)
    s.shapes.add_movie(os.path.join(OUT, "pact_demo_60s.mp4"), Pt(vx), Pt(vy), Pt(vw), Pt(vh),
                       poster_frame_image=os.path.join(IMG, "video_poster.jpg"), mime_type="video/mp4")
    text(s, vx, vy + vh + 8, vw, 18, [[("▶ Click to play · 65 s · ", {"bold": True, "color": DEEP}),
                                     ("full 3-minute walkthrough: QR code on slide 11", {})]], size=9.5,
         color=MUTED)
    text(s, 620, 92, 298, 16, [[("WATCH FOR", {"bold": True})]], size=9, color=DEEP)
    cues = [("0:11", "Same city, seed and orders, run twice", INK),
            ("0:19", "The hub is killed (left side)", RED),
            ("0:21", "The central fleet stops taking new work", RED),
            ("0:29", "PACT keeps going: 86% on time", DEEP),
            ("0:40", "Radio splits the fleet: 0 double deliveries in 240 runs", VIOLET)]
    for i, (t, d, c) in enumerate(cues):
        y = 112 + i * 54
        box(s, 620, y, 298, 48, fill=WHITE, line=LINE, radius=8)
        label_box(s, 628, y + 12, 44, 24, [[(t, {"bold": True})]], c, WHITE, size=10.5, radius=12)
        text(s, 680, y + 4, 232, 40, d, size=10.5, color=INK, anchor="m")
    band(s, "WHAT YOU JUST SAW", ["Hub killed at 3:00", "Central fleet stalls", "PACT: no drop, 0 duplicates"])
    pageno(s, 5)
    notes(s, "5:30-7:00. Click to play. Call out each cue as it happens: hub killed, the central side freezes, "
             "PACT carries on, then the radio split with zero duplicates.")


def s6_lineage(prs, s):
    rail(s, 2)
    takeaway(s, "Built three times, each step closer to the sky: real robots → simulator → real autopilots.")
    cols = [("SIH 2026 · AisleZero (same team)", "bel_robot_review.jpg", (0.5, 0.5),
             "Real robots, real engineers",
             ["Leases, epochs and peer-to-peer coordination first ran on Jetson Nano AMRs with LiDAR, ROS 2 + Nav2",
              "Workflow reviewed with engineers at Bharat Electronics Ltd (BEL)"],
             "Hardware-validated", DEEP),
            ("PACT simulator · sim3d", "sim3d.png", (0.45, 0.4), "Every fault, on demand",
             ["Live in the browser, headless for benchmarks: 8 city maps, about 30 fault scenarios",
              "391 tests · 75/75 scenario checks · 340 benchmark runs"],
             "Deterministic replays", DEEP),
            ("AeroPACT · ROS 2 + Gazebo + PX4", "gz_fleet.jpg", (0.5, 0.55), "Real autopilot software",
             ["One ROS 2 lifecycle container per drone in Gazebo Harmonic",
              "PX4 v1.16 SITL autopilots over uXRCE-DDS · 692 tests · 9/9 acceptance · 4/4 PX4 SITL"],
             "Flight-stack ready", VIOLET)]
    w, g = 280, 18
    for i, (tag, img, f, head, bullets, chip, cc) in enumerate(cols):
        x = 42 + i * (w + g)
        box(s, x, 92, w, 344, fill=WHITE, line=LINE, radius=12)
        picture(s, img, x + 4, 96, w - 8, 150, focus=f, radius=9)
        label_box(s, x + 10, 104, 160, 18, [[(tag, {"bold": True})]], WHITE, INK, size=7.5, radius=9)
        text(s, x + 12, 254, w - 24, 20, [[(head, {"bold": True})]], size=13, color=INK)
        text(s, x + 12, 278, w - 24, 120, [[("•  ", {"bold": True, "color": LIME}), (b, {})] for b in bullets],
             size=10, color=SLATE, after=5, spacing=1.08)
        label_box(s, x + 12, 404, w - 24, 22, [[(chip, {"bold": True})]], TINT if cc == DEEP else VTINT, cc,
                  size=9.5, radius=11)
        if i < 2:
            arrow(s, x + w + 3, 162, 12, 16, color=LIME)
    band(s, "NEXT STEP", ["Hardware in the loop: companion computers + real mesh radios",
                          "Indoor flight trial, Mar–Jun 2027"])
    pageno(s, 6)
    notes(s, "7:00-8:00. Answer the hardware question before it is asked: the same coordination ideas already ran "
             "on our AisleZero robots for SIH and were reviewed at BEL; PACT moves them to drones in simulation and "
             "on PX4 autopilot software.")


def s7_roadmap(prs, s):
    rail(s, 3)
    takeaway(s, "Software is done. Hardware is next, with a date and a number on every step.")
    phases = [("DONE · Oct 2026", "Software prototype, two builds", "86.3% on time after hub loss · 0 duplicates · 990+ tests", LIME, INK),
              ("PHASE 1 · Dec 2026 – Feb 2027", "Hardware in the loop", "0 duplicates in 100 runs with real packet loss · decision tick under 50 ms", TINT, DEEP),
              ("PHASE 2 · Mar – Jun 2027", "Indoor flight trial (4–6 quadcopters)", "50 missions with hub-kill and radio-cut · 0 duplicates · 0 loss of separation", TINT, DEEP),
              ("PHASE 3 · Jul – Dec 2027", "Scale and partner pilot", "50+ simulated drones at today's message load · 200 pilot deliveries under DGCA rules", TINT, DEEP)]
    for i, (when, what, target, f, c) in enumerate(phases):
        y = 92 + i * 86
        badge(s, 42, y + 26, 26, "✓" if i == 0 else str(i), fill=LIME if i == 0 else WHITE, color=INK, size=11)
        if i == 0:
            pass
        else:
            s.shapes[-1].line.color.rgb = rgb(LIME)
        if i < 3:
            box(s, 54, y + 54, 2, 58, fill=LIME)
        box(s, 78, y, 470, 78, fill=WHITE, line=LIME if i == 0 else LINE, lw=1.5 if i == 0 else 1, radius=10)
        text(s, 90, y + 6, 250, 14, [[(when, {"bold": True})]], size=8, color=DEEP)
        text(s, 90, y + 20, 250, 50, [[(what, {"bold": True})]], size=12.5, color=INK)
        label_box(s, 330, y + 8, 210, 62, [[("TARGET  " if i else "ACHIEVED  ", {"bold": True, "size": 7.5}), (target, {})]],
                  f, c if i else INK, size=9.5, align="l", radius=8, inset=8)
    text(s, 566, 92, 352, 16, [[("RISKS WE ALREADY PLAN FOR", {"bold": True})]], size=9, color=RED)
    risks = [("Real radios drop more packets than a simulator",
              "Hardware-in-the-loop first; gossip and leases already pass maps with +30% packet loss"),
             ("Drone delivery rules (DGCA)",
              "Start indoors in a netted arena, then pilot with a certified operator"),
             ("Cost of onboard compute",
              "Runs on a Raspberry Pi 5-class board; coordination tick p95 = 0.1 ms in simulation")]
    for i, (ch, mit) in enumerate(risks):
        y = 112 + i * 108
        box(s, 566, y, 352, 100, fill=WHITE, line=LINE, radius=10)
        label_box(s, 576, y + 8, 332, 34, [[(ch, {"bold": True})]], RTINT, RED, size=10, align="l", radius=7, inset=8)
        text(s, 576, y + 46, 20, 20, [[("→", {"bold": True, "size": 14})]], color=DEEP)
        text(s, 596, y + 46, 312, 50, mit, size=10, color=INK)
    band(s, "WHO IT SERVES", ["Parcel delivery fleets", "Hospitals and labs", "Disaster relief", "Ports, plants, campuses"])
    pageno(s, 7)
    notes(s, "8:00-9:15. Each phase has a date and a measurable target. Phase 2 is the moment of truth: kill the "
             "hub and cut the radio during live indoor flights. Then the three risks and how we handle them.")


def s8_cost(prs, s):
    rail(s, 3)
    takeaway(s, "What it costs: about ₹17k per drone, once. ₹0 software. No hub bills.",
             "Indicative estimate from live Indian retail prices (incl. GST, seen 20 Nov 2026) and published figures. Sources below.")
    # BOM
    box(s, 42, 100, 330, 336, fill=WHITE, line=LINE, radius=10)
    text(s, 54, 106, 300, 14, [[("PACT ADD-ON PER DRONE · ONE-TIME", {"bold": True})]], size=8.5, color=DEEP)
    bom = [("Raspberry Pi 5 (4 GB) companion computer", "13,409", "robu.in"),
           ("ESP32-S3 mesh radio (ESP-NOW)", "1,299", "probots.co.in"),
           ("64 GB A2 microSD", "1,649", "computechstore.in"),
           ("5 V / 5 A regulator (UBEC)", "362", "zbotic.in"),
           ("Active cooler and mount", "499", "indianhobbycenter.com")]
    for i, (item, price, src) in enumerate(bom):
        y = 126 + i * 34
        box(s, 54, y + 30, 306, 0.75, fill=LINE)
        text(s, 54, y, 230, 30, [[(item, {"color": INK})], [(src, {"size": 7.5, "color": MUTED})]], size=10,
             spacing=1.0)
        text(s, 280, y, 80, 30, [[("₹" + price, {"bold": True})]], size=11, color=INK, align="r", anchor="m")
    text(s, 54, 300, 200, 26, [[("Total per drone", {"bold": True})]], size=11.5, color=INK, anchor="m")
    text(s, 240, 296, 120, 32, [[("₹17,218", {"bold": True, "size": 20, "color": DEEP})]], align="r", anchor="m")
    label_box(s, 54, 332, 306, 44, [[("Already flying a companion computer? ", {"bold": True}),
                                     ("PACT then adds only the ₹1,299 radio.", {})]], TINT, INK, size=9.5,
              align="l", radius=8, inset=8)
    text(s, 54, 382, 306, 50, [[("Upgrade path: ", {"bold": True}),
                                ("Jetson Orin Nano Super ₹54,999 (varietyinfotech.com) + Wi-Fi HaLow radio ₹9,900 "
                                 "(tanotis.com). Software: ROS 2, PX4, Gazebo, ", {}),
                                ("₹0", {"bold": True, "color": DEEP}), (" (Apache-2.0 / BSD-3).", {})]],
         size=8.5, color=SLATE)
    # hub
    box(s, 386, 100, 262, 336, fill=WHITE, line=LINE, radius=10)
    text(s, 398, 106, 240, 14, [[("WHAT A CENTRAL HUB COSTS · PER YEAR", {"bold": True})]], size=8.5, color=RED)
    hub = [("Hub server + hot standby", "₹73,400", "2 × AWS EC2 t3.medium, Mumbai, $0.0448/h, ₹93.5/$"),
           ("4G M2M link per drone", "₹8,388", "₹699/month (reseller listing)"),
           ("6-drone fleet, per year", "≈ ₹1.24 L", "hub + 6 links, every year")]
    for i, (k, v, sub) in enumerate(hub):
        y = 126 + i * 58
        text(s, 398, y, 150, 50, [[(k, {"color": INK, "bold": i == 2})], [(sub, {"size": 7.5, "color": MUTED})]],
             size=10, spacing=1.0)
        text(s, 548, y, 92, 30, [[(v, {"bold": True, "color": RED, "size": 13 if i < 2 else 15})]], align="r")
    box(s, 398, 304, 238, 120, fill=TINT, radius=8)
    text(s, 408, 310, 220, 110, [[("PACT for the same 6 drones", {"bold": True, "color": INK})],
                                 [("≈ ₹1.03 L once", {"bold": True, "size": 20, "color": DEEP})],
                                 [("pays for itself in about ", {}), ("10 months", {"bold": True}),
                                  (", then keeps saving the hub's yearly bill", {})]], size=9.5, color=SLATE, after=2)
    # value
    box(s, 662, 100, 256, 336, fill=INK, radius=10)
    text(s, 674, 106, 236, 14, [[("WHAT IT SAVES IN A HUB OUTAGE", {"bold": True})]], size=8.5, color=LIME)
    text(s, 674, 128, 236, 84, [[("49.6", {"bold": True, "size": 34, "color": LIME})],
                                [("extra deliveries per hour kept by 6 drones", {"color": WHITE})]], size=10)
    text(s, 674, 214, 236, 40, [[("20.0 vs 7.6 deliveries per 15 min after the hub dies (our benchmark)", {})]],
         size=8.5, color="CFCFCF")
    box(s, 674, 254, 232, 0.75, fill="5A5A5A")
    text(s, 674, 262, 236, 80, [[("₹1,240 – 1,984", {"bold": True, "size": 22, "color": WHITE})],
                                [("per hour of outage, at ₹25–40 per delivery by road", {"color": WHITE})]], size=10)
    text(s, 674, 344, 236, 84, [[("Road cost per delivery: Skye Air CEO, Khaleej Times, 24 May 2026. "
                                  "Throughput is from simulation; treat ₹ values as indicative.", {})]],
         size=8, color="CFCFCF")
    text(s, 42, 438, 876, 10, "", size=1)
    band(s, "COST CASE", ["₹0 software licences", "≈10-month payback vs a hub (6 drones)",
                          "₹1.2k–2k kept per outage hour"])
    pageno(s, 8)
    notes(s, "9:15-10:30. Every price is a live Indian retail listing (incl. GST) seen 20 Nov 2026: robu.in Pi 5 4GB "
             "₹13,409; probots ESP32-S3 ₹1,299; computechstore microSD ₹1,649; zbotic UBEC ₹362.25; indianhobbycenter "
             "cooler ₹499; varietyinfotech Orin Nano Super ₹54,999; tanotis HaLow HAT ₹9,900. AWS t3.medium Mumbai "
             "$0.0448/h via doit.com aggregator, ₹93.5/$ (18 Nov 2026). M2M SIM ₹699/month is a reseller listing "
             "(weak). Delivery cost ₹25-40 by road: Skye Air CEO in Khaleej Times, 24 May 2026. Payback: 6 × 17,218 "
             "= ₹1,03,308 vs ₹73,400 + 6 × 8,388 = ₹1,23,728 per year → about 10 months.")


def s9_arch(prs, s):
    rail(s, 4)
    takeaway(s, "Inside every drone: the same six-layer stack, and nothing central.")
    layers = [("Mesh radio", "Range-limited and lossy; talks only to neighbours. Authenticated in AeroPACT.", VTINT, VIOLET),
              ("Gossip sync", "Exchanges order-board updates and heartbeats with neighbours.", VTINT, VIOLET),
              ("Coordination", "Order board (CRDT) · auction · epoch + lease · zombie-stop · partition policy · failure detector", TINT, DEEP),
              ("Flight manager", "A* routes around buildings and no-fly zones; battery reserve; charging pads booked ahead.", GREY, INK),
              ("Safety supervisor", "Keeps separation. Isolated: never imports coordination or network code.", RTINT, RED),
              ("Autopilot", "PX4 via uXRCE-DDS in AeroPACT; kinematic model in the browser simulator.", INK, LIME)]
    for i, (n, d, f, c) in enumerate(layers):
        y = 92 + i * 57
        box(s, 42, y, 400, 51, fill=f, radius=8, line=LIME if n == "Coordination" else None, lw=1.5)
        text(s, 54, y, 120, 51, [[(n, {"bold": True})]], size=12, color=c, anchor="m")
        text(s, 172, y, 262, 51, d, size=9.5, color=WHITE if f == INK else SLATE, anchor="m")
    label_box(s, 452, 96, 116, 92, [[("Depot", {"bold": True, "size": 11})],
                                    [("hands a parcel only to the highest valid epoch", {"size": 8.5})]],
              TINT, INK, radius=8, line=LIME, inset=6)
    label_box(s, 452, 196, 116, 92, [[("No server", {"bold": True, "size": 11})],
                                     [("no hub, no leader, no shared database", {"size": 8.5})]],
              GREY, INK, radius=8, inset=6)
    label_box(s, 452, 296, 116, 136, [[("ROS 2 build", {"bold": True, "size": 11})],
                                      [("one container per drone: coordinator, flight manager and safety supervisor "
                                        "as lifecycle nodes", {"size": 8.5})]], GREY, INK, radius=8, inset=6)
    box(s, 584, 92, 334, 340, fill=WHITE, line=LINE, radius=10)
    text(s, 596, 98, 300, 14, [[("RESEARCH BEHIND EACH PART", {"bold": True})]], size=8.5, color=VIOLET)
    refs = [("Consensus-based bundle algorithm (CBBA)", "Choi, Brunet, How · IEEE T-RO 2009", "→ our auction and baseline"),
            ("Conflict-free replicated data types", "Shapiro et al. · SSS 2011", "→ shared order board"),
            ("Leases for distributed consistency", "Gray, Cheriton · SOSP 1989", "→ job leases"),
            ("Fencing tokens", "Kleppmann · DDIA 2017", "→ epoch + depot check"),
            ("CAP theorem", "Brewer 2000 · Gilbert, Lynch 2002", "→ partition policies")]
    for i, (t, a, u) in enumerate(refs):
        y = 118 + i * 52
        if i:
            box(s, 596, y - 4, 310, 0.75, fill=LINE)
        text(s, 596, y, 310, 46, [[(t, {"bold": True, "color": INK})], [(a, {"size": 8.5, "color": MUTED})],
                                  [(u, {"size": 9, "color": DEEP, "bold": True})]], size=10, spacing=1.0)
    band(s, "BUILT WITH", ["TypeScript · Three.js · React", "ROS 2 Jazzy · C++", "Gazebo Harmonic", "PX4 v1.16 SITL"])
    pageno(s, 9)
    notes(s, "10:30-11:30. Top to bottom: network, coordination, flight, safety, autopilot. Stress the isolated "
             "safety supervisor, and that each part rests on published research we extend.")


def s10_results(prs, s):
    rail(s, 4)
    takeaway(s, "Measured, repeatable, honest: 340 runs with 95% confidence intervals.")
    box(s, 42, 92, 300, 344, fill=WHITE, line=LINE, radius=10)
    text(s, 54, 98, 280, 30, [[("RESULT 1 · HUB KILLED AT t = 180 s", {"bold": True, "size": 8, "color": DEEP})],
                              [("On time after hub loss", {"bold": True, "size": 12.5, "color": INK})]])
    bars = [("PACT (ours)", 86.3, LIME, DEEP), ("Central hub, never fails", 86.3, "C9CCD0", SLATE),
            ("Plain auction", 83.4, "C9CCD0", SLATE), ("Greedy nearest", 80.6, "C9CCD0", SLATE),
            ("Central hub, killed", 56.8, RED, RED)]
    for i, (n, v, f, c) in enumerate(bars):
        y = 140 + i * 40
        text(s, 54, y, 230, 14, [[(n, {"bold": i == 0})]], size=9.5, color=c if i == 0 else INK)
        box(s, 54, y + 16, 220, 14, fill=GREY, radius=4)
        box(s, 54, y + 16, 220 * v / 100, 14, fill=f, radius=4)
        text(s, 278, y + 12, 56, 20, [[(f"{v}%", {"bold": True})]], size=11, color=c, align="r")
    text(s, 54, 346, 280, 80, [[("100-run benchmark, 5 seeds × 900 s. With nothing central to lose, PACT matches a "
                                 "central planner that never fails.", {})]], size=9, color=MUTED)
    box(s, 354, 92, 300, 344, fill=WHITE, line=LINE, radius=10)
    text(s, 366, 98, 280, 30, [[("RESULT 2 · 5-MINUTE RADIO SPLITS", {"bold": True, "size": 8, "color": VIOLET})],
                               [("Fencing removes double deliveries", {"bold": True, "size": 12.5, "color": INK})]])
    rows = [("Radio canyons", "PACT", "82.1–88.6%", "0"), ("Radio canyons", "Plain auction", "98.5%", "17.8"),
            ("Coastal split", "PACT", "76.9–80.9%", "0"), ("Coastal split", "Plain auction", "84.1%", "3.7")]
    text(s, 366, 136, 280, 12, [[("SCENARIO · SYSTEM", {"bold": True}), ("", {})]], size=7.5, color=MUTED)
    text(s, 520, 136, 126, 12, [[("ON TIME   DUP./RUN", {"bold": True})]], size=7.5, color=MUTED, align="r")
    for i, (sc, sy, ot, d) in enumerate(rows):
        y = 152 + i * 40
        box(s, 366, y, 278, 34, fill=TINT if sy == "PACT" else "FAFAFA", radius=6)
        text(s, 374, y, 150, 34, [[(sc, {"color": INK})], [(sy, {"bold": sy == "PACT", "color": DEEP if sy == "PACT" else MUTED, "size": 8.5})]],
             size=9.5, anchor="m", spacing=1.0)
        text(s, 500, y, 80, 34, ot, size=9.5, color=INK, align="r", anchor="m")
        text(s, 584, y, 54, 34, [[(d, {"bold": True})]], size=13, color=DEEP if d == "0" else RED, align="r", anchor="m")
    text(s, 366, 318, 280, 110, [[("240 runs, 30 seeds, all completed. The plain auction looks more punctual only "
                                   "because it flies the same parcels twice. PACT: 0 duplicates, 0 zombie pickups.", {})]],
         size=9, color=MUTED)
    box(s, 666, 92, 252, 344, fill=RTINT, radius=10)
    text(s, 678, 98, 230, 30, [[("HONEST LIMITS", {"bold": True, "size": 8, "color": RED})],
                               [("Where PACT does not win yet", {"bold": True, "size": 12.5, "color": INK})]])
    lims = ["Battery crunch: 55.0% on time vs 56.8% for the hub (confidence intervals overlap).",
            "Under radio splits, fencing costs some punctuality: a safe drone waits instead of guessing.",
            "Check AT-05 is logged as FAIL: the hub baseline dropped 34.1%, short of our 40% gate. PACT's side passed.",
            "2 of 240 sweep runs logged one loss of separation each (STRICT policy, canyon map).",
            "Simulation only so far. Not flight-ready."]
    text(s, 678, 140, 232, 290, [[("•  ", {"bold": True, "color": RED}), (l, {})] for l in lims], size=9.5,
         color=INK, after=6, spacing=1.05)
    band(s, "SOURCES", ["results/summary.md", "results/sweep/sweep.md", "results/recovery.json", "aeropact/results"])
    pageno(s, 10)
    notes(s, "11:30-12:30. Two results with confidence intervals, then the limits we found ourselves. Judges will "
             "ask about the plain auction's higher on-time rate: it delivers parcels twice.")


def s11_validation(prs, s):
    rail(s, 4)
    takeaway(s, "Shaped by the field: BEL engineers reviewed our first build (AisleZero, SIH 2026, same team).")
    picture(s, "bel_gate.jpg", 42, 92, 206, 118, radius=8)
    picture(s, "bel_robot_review.jpg", 254, 92, 206, 118, radius=8)
    text(s, 42, 214, 418, 30, [[("Workflow review at Bharat Electronics Ltd with our AisleZero robot. "
                                 "Their insights shaped PACT's design.", {"italic": True})]], size=9, color=MUTED)
    experts = [("exp_alok.jpg", "Alok Kumar", "BEL, Bengaluru Unit", "One robot or a blocked aisle must not stop the fleet.",
                "No hub: a silent drone's lease expires and a neighbour takes over (9.9 s median)."),
               ("exp_karthikesh.jpg", "Karthikesh J G", "Founder & CEO, Karthikesh Robotics",
                "Existing hardware and safety controls should stay unchanged.",
                "PACT is an add-on beside PX4; the safety supervisor never imports coordination code."),
               ("exp_avinash.jpg", "Avinash Chandak", "Research Staff, BEL Ghaziabad",
                "The WMS supplies tasks; robots should coordinate in real time locally.",
                "Depots publish jobs; drones decide among themselves over the mesh radio.")]
    for i, (img, n, role, ins, resp) in enumerate(experts):
        y = 92 + i * 86
        box(s, 476, y, 442, 80, fill=WHITE, line=LINE, radius=10)
        pic = picture(s, img, 486, y + 10, 44, 44)
        pic.auto_shape_type = MSO_SHAPE.OVAL
        text(s, 486, y + 56, 90, 22, [[(n, {"bold": True, "size": 7.5, "color": INK})], [(role, {"size": 6, "color": MUTED})]],
             spacing=0.95)
        text(s, 580, y + 6, 330, 34, [[("INSIGHT  ", {"bold": True, "size": 7.5, "color": VIOLET}), ("“" + ins + "”", {"italic": True})]],
             size=9.5, color=INK, spacing=1.0)
        text(s, 580, y + 42, 330, 34, [[("PACT'S ANSWER  ", {"bold": True, "size": 7.5, "color": DEEP}), (resp, {})]],
             size=9.5, color=INK, spacing=1.0)
    box(s, 42, 250, 418, 186, fill=WHITE, line=LINE, radius=10)
    text(s, 54, 256, 380, 14, [[("PRIOR ART WE EXTEND", {"bold": True})]], size=8.5, color=VIOLET)
    text(s, 54, 274, 396, 160, [
        [("Multi-robot task allocation, consensus-based auctions  ", {"color": INK}), ("sciencedirect.com/…/S0921889022001592", {"size": 8, "color": DEEP, "link": "https://www.sciencedirect.com/science/article/pii/S0921889022001592"})],
        [("Distributed auction algorithms for multi-robot assignment  ", {"color": INK}), ("sciencedirect.com/…/S1366554524004745", {"size": 8, "color": DEEP, "link": "https://www.sciencedirect.com/science/article/abs/pii/S1366554524004745"})],
        [("Robotic mobile fulfilment systems  ", {"color": INK}), ("authors.library.caltech.edu/records/yhvy1-c4k91", {"size": 8, "color": DEEP, "link": "https://authors.library.caltech.edu/records/yhvy1-c4k91"})],
        [("What is new in PACT: ", {"bold": True, "color": INK}),
         ("fenced ownership (epoch + lease + depot check) together with a fixed partition rule, so split groups "
          "never double-deliver.", {})]], size=9, color=SLATE, after=5, spacing=1.05)
    qrs = [("qr_video.png", "Demo video", "https://drive.google.com/file/d/1qlPbHO_VTEOLMpG-KsM2Ratiawf_xRO6/view?usp=sharing"),
           ("qr_repo.png", "Source code", "https://github.com/MrNK2107/PACT"),
           ("qr_docs.png", "4 reports", "https://drive.google.com/drive/folders/1-udBn0FYfy1-YIIxnf0yAcD5kpeAF4en?usp=sharing")]
    for i, (img, lab, url) in enumerate(qrs):
        x = 476 + i * 150
        box(s, x, 352, 142, 84, fill=INK, radius=10)
        q = picture(s, img, x + 8, 360, 68, 68)
        q.click_action.hyperlink.address = url
        text(s, x + 80, 360, 60, 68, [[(lab, {"bold": True, "color": WHITE})], [("scan or click", {"size": 7.5, "color": LIME})]],
             size=9.5, anchor="m")
    band(s, "WHERE TO LOOK NEXT", ["github.com/MrNK2107/PACT", "Demo video (3 min)", "Design, evaluation, setup reports"])
    pageno(s, 11)
    notes(s, "12:30-13:30. The coordination ideas were first reviewed with BEL engineers on our SIH 2026 robot "
             "(AisleZero, same team). Each insight and how PACT answers it. Close with the links. 13:30-15:00 questions.")


def main():
    import shutil
    shutil.copyfile(TEMPLATE, SCRATCH)
    prs = Presentation(SCRATCH)
    guidelines = prs.slides[0]
    opening = prs.slides[1]
    s1_opening(prs, opening)

    inn = find_slide(prs, "What is the innovation in your idea?")
    clear_body(inn); s2_problem(prs, inn)
    inn2 = add_continuation(prs, "What is the innovation in your idea?"); s3_story(prs, inn2)
    dif = find_slide(prs, "Key Differentiators:")
    clear_body(dif); s4_diff(prs, dif)
    pro = find_slide(prs, "Prototype/Proof of concept")
    clear_body(pro); s5_video(prs, pro)
    pro2 = add_continuation(prs, "Prototype/Proof of concept"); s6_lineage(prs, pro2)
    fut = find_slide(prs, "Future Plans/potential next steps ")
    clear_body(fut); s7_roadmap(prs, fut)
    fut2 = add_continuation(prs, "Future Plans/potential next steps "); s8_cost(prs, fut2)
    tec = find_slide(prs, "Technical Details and Reports ")
    clear_body(tec); s9_arch(prs, tec)
    tec2 = add_continuation(prs, "Technical Details and Reports "); s10_results(prs, tec2)
    tec3 = add_continuation(prs, "Technical Details and Reports "); s11_validation(prs, tec3)

    # drop the Guidelines slide last, so new slide part names never collide
    for el in list(prs.slides._sldIdLst):
        if prs.part.related_part(el.get(qn("r:id"))) is guidelines.part:
            prs.part.drop_rel(el.get(qn("r:id")))
            prs.slides._sldIdLst.remove(el)
    order = [opening, inn, inn2, dif, pro, pro2, fut, fut2, tec, tec2, tec3]
    for i, sl in enumerate(order):
        move_slide(prs, sl, i)
    prs.save(SCRATCH)
    os.replace(SCRATCH, FINAL)
    print("saved", FINAL, round(os.path.getsize(FINAL) / 1e6, 1), "MB,", len(prs.slides), "slides")


if __name__ == "__main__":
    main()
