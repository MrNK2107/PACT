"""
QR codes for slide 13 (links). Writes qr/<name>.svg next to this script; the slide shows them as images.
Set a link to None to leave a placeholder on the slide.
    python qr.py
"""
import pathlib

import segno

LINKS = {
    "video": "https://drive.google.com/file/d/1qlPbHO_VTEOLMpG-KsM2Ratiawf_xRO6/view?usp=sharing",
    "repo": "https://github.com/MrNK2107/PACT",
    "docs": "https://drive.google.com/drive/folders/1-udBn0FYfy1-YIIxnf0yAcD5kpeAF4en?usp=sharing",
}

out = pathlib.Path(__file__).resolve().parent / "qr"
out.mkdir(exist_ok=True)
for name, url in LINKS.items():
    dest = out / f"{name}.svg"
    if url is None:
        dest.unlink(missing_ok=True)
        print(f"{name}: no link, placeholder")
        continue
    # high error correction, ink on white, no quiet zone (the card provides the margin)
    segno.make(url, error="h").save(dest, kind="svg", scale=10, border=0, dark="#121614", light="#FFFFFF", xmldecl=False)
    print(f"{name}: {url} -> {dest.name}")
