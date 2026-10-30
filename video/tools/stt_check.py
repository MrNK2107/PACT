"""Transcribe each voiceover clip with ElevenLabs speech-to-text and compare it with the script (word level)."""
import difflib, json, pathlib, re, urllib.error, urllib.request, uuid

V = pathlib.Path(__file__).resolve().parents[1]
raw = (pathlib.Path.home() / ".secrets" / "elevenlabs.key").read_text(encoding="utf-8-sig")
KEYS = re.findall(r"sk_[A-Za-z0-9]+|[A-Fa-f0-9]{32}", raw)


def words(s):
    return re.findall(r"[a-z0-9]+", s.lower().replace("-", " "))


def stt(path, key):
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\nContent-Type: audio/mpeg\r\n\r\n').encode()
    body += path.read_bytes() + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request("https://api.elevenlabs.io/v1/speech-to-text", data=body, method="POST",
                                 headers={"xi-api-key": key, "Content-Type": f"multipart/form-data; boundary={b}"})
    return json.load(urllib.request.urlopen(req, timeout=120))["text"]


cfg = json.loads((V / "script" / "narration.json").read_text(encoding="utf-8"))
for seg in cfg["segments"]:
    p = V / "audio" / "vo" / f'{seg["id"]}.mp3'
    try:
        heard = stt(p, KEYS[1])
    except urllib.error.HTTPError as e:
        print(seg["id"], "STT HTTP", e.code, e.read()[:200])
        break
    a, b = words(seg["text"]), words(heard)
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    diffs = [f"{op}: {' '.join(a[i1:i2])!r} -> {' '.join(b[j1:j2])!r}"
             for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes() if op != "equal"]
    print(f'{seg["id"]:<13} match {ratio:.3f}', "; ".join(diffs[:4]))
