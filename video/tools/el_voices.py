"""List the ElevenLabs voices available to the first key (names, ids, labels). Never prints the key."""
import json, pathlib, re, urllib.request

raw = (pathlib.Path.home() / ".secrets" / "elevenlabs.key").read_text(encoding="utf-8-sig")
key = re.findall(r"sk_[A-Za-z0-9]+|[A-Fa-f0-9]{32}", raw)[0]
req = urllib.request.Request("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": key})
d = json.load(urllib.request.urlopen(req, timeout=30))
for v in d["voices"]:
    lab = v.get("labels") or {}
    print(f'{v["voice_id"]}  {v["name"]:<28} {v.get("category",""):<10} {lab.get("gender","")}/{lab.get("accent","")}/{lab.get("age","")} {lab.get("use_case", lab.get("description",""))}')
