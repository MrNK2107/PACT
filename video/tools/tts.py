"""
Voiceover for the PACT video: one MP3 per narration segment (video/script/narration.json) with ElevenLabs.

Keys come from ~/.secrets/elevenlabs.key (one or more, free tier) and are never printed. Each segment
uses the first key with enough characters left, so the three free quotas are used one after another.
A segment is regenerated only when its text, voice, model or voice settings change (a hash sidecar), so re-runs are cheap.
    python tts.py [--only s3_hub]
"""
import argparse, hashlib, json, pathlib, re, subprocess, sys, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "audio" / "vo"
API = "https://api.elevenlabs.io/v1"


def keys():
    raw = (pathlib.Path.home() / ".secrets" / "elevenlabs.key").read_text(encoding="utf-8-sig")
    return re.findall(r"sk_[A-Za-z0-9]+|[A-Fa-f0-9]{32}", raw)


def remaining(key):
    req = urllib.request.Request(f"{API}/user/subscription", headers={"xi-api-key": key})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    return d["character_limit"] - d["character_count"]


DEFAULT_SETTINGS = {"stability": 0.55, "similarity_boost": 0.8, "style": 0.15, "use_speaker_boost": True}


def synth(key, voice, model, text, dest, settings=DEFAULT_SETTINGS):
    body = json.dumps({"text": text, "model_id": model, "voice_settings": settings}).encode()
    req = urllib.request.Request(f"{API}/text-to-speech/{voice}?output_format=mp3_44100_128", data=body, method="POST",
                                 headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    with urllib.request.urlopen(req, timeout=120) as r:
        dest.write_bytes(r.read())


def duration(p):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                         capture_output=True, text=True).stdout.strip()
    return float(out or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    a = ap.parse_args()
    cfg = json.loads((ROOT / "script" / "narration.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    ks = keys()
    left = [remaining(k) for k in ks]
    print("keys:", len(ks), "characters left:", left)
    settings = cfg.get("voice_settings", DEFAULT_SETTINGS)
    durations = {}
    for seg in cfg["segments"]:
        sid, text = seg["id"], seg["text"]
        dest, tag = OUT / f"{sid}.mp3", OUT / f"{sid}.hash"
        h = hashlib.sha256(f'{cfg["voice_id"]}|{cfg["model_id"]}|{json.dumps(settings, sort_keys=True)}|{text}'.encode()).hexdigest()
        if (a.only and sid != a.only) or (dest.exists() and tag.exists() and tag.read_text() == h):
            durations[sid] = duration(dest) if dest.exists() else 0
            continue
        i = next((j for j, n in enumerate(left) if n >= len(text) + 20), None)
        if i is None:
            sys.exit("no key has enough characters left")
        try:
            synth(ks[i], cfg["voice_id"], cfg["model_id"], text, dest, settings)
        except urllib.error.HTTPError as e:
            sys.exit(f"{sid}: HTTP {e.code} {e.read()[:200]!r}")
        left[i] -= len(text)
        tag.write_text(h)
        durations[sid] = duration(dest)
        print(f"{sid}: {len(text)} chars, key {i}, {durations[sid]:.2f} s")
    (OUT / "durations.json").write_text(json.dumps(durations, indent=1))
    print("total voice:", round(sum(durations.values()), 1), "s; characters left:", left)


if __name__ == "__main__":
    main()
