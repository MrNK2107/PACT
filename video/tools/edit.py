"""
Assembles the PACT video from the rendered pieces (video/threejs, video/gazebo, video/cards, video/audio/vo).

Every segment is built to an exact length at 1920x1080, 30 fps, with its narration clip laid in at a fixed
offset, then the segments are joined. Writes video/out/pact_video.mp4, video/out/pact_video.srt and
video/out/timeline.json (what came from where). Re-runnable: each segment is cached by its recipe.
    python edit.py            # full video
    python edit.py --short    # the 60 s cut
"""
import argparse, hashlib, json, pathlib, re, subprocess

V = pathlib.Path(__file__).resolve().parents[1]
OUT = V / "out"
SEG = OUT / "segments"
FPS = 30
VO = V / "audio" / "vo"
CARDS = V / "cards"
TJ = V / "threejs"
GZ = V / "gazebo"


def ff(args):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + args, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("ffmpeg failed:\n" + " ".join(args) + "\n" + r.stderr[-2000:])


def dur(p):
    """Duration in seconds; 0 for a file that is missing or still being written."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                         capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


# ---- segment recipes ------------------------------------------------------------------------------------------
# kind "card": a still PNG. kind "clips": [(file, start, end)] joined with short dissolves, optional overlays
# [(png, from_s, to_s)] on top. "split": two clip lists side by side in the split frame. vo: (segment id, offset s).
def recipes(short=False):
    gz_clips = [(GZ / "gz_demo_pact.mp4", 22.0, 28.5), (GZ / "gz_demo_pact.mp4", 37.0, 44.0),
                (GZ / "gz_demo_pact.mp4", 187.5, 193.5)]
    gz_over = [(CARDS / "gz_2.png", 0.3, 5.9), (CARDS / "gz_1.png", 6.4, 12.6), (CARDS / "gz_3.png", 13.1, 18.7)]
    px4 = GZ / "gz_px4.mp4"
    if px4.exists() and dur(px4) > 40:
        # PX4 x500 (A04) lifting off its pad at depot D2 under offboard control
        gz_clips.append((px4, 5.0, 12.5))
        gz_over.append((CARDS / "gz_4.png", 19.2, 25.6))
    full = [
        dict(id="title", kind="card", png=CARDS / "title.png", length=10.5, vo=("s0_title", 0.8)),
        dict(id="problem", kind="card", png=CARDS / "problem.png", length=17.0, vo=("s1_problem", 0.6)),
        dict(id="intro", kind="clips", clips=[(TJ / "scene_intro.mp4", 3.0, 27.4)], length=24.4, vo=("s2_intro", 0.8)),
        dict(id="hub", kind="split", left=[(TJ / "split540_hub_central.mp4", 6.0, 24.0), (TJ / "split540_hub_central.mp4", 34.5, 46.5)],
             right=[(TJ / "split540_hub_pact.mp4", 6.0, 24.0), (TJ / "split540_hub_pact.mp4", 34.5, 46.5)],
             overlays=[(CARDS / "split_a.png", 0.0, 18.0), (CARDS / "split_b.png", 18.0, 30.0)], length=30.0, vo=("s3_hub", 1.0)),
        dict(id="partition", kind="clips", clips=[(TJ / "scene_partition.mp4", 4.0, 18.0), (TJ / "scene_partition.mp4", 34.0, 44.0),
                                                  (TJ / "scene_partition.mp4", 50.0, 56.5)], length=30.5, vo=("s4_partition", 0.8)),
        dict(id="failure", kind="clips", clips=[(TJ / "scene_failure.mp4", 0.5, 14.0), (TJ / "scene_failure.mp4", 16.0, 24.0)],
             length=21.5, vo=("s5_failure", 1.0)),
        dict(id="gazebo", kind="clips", clips=gz_clips, overlays=gz_over, length=None, vo=("s6_gazebo", 1.2)),
        dict(id="verify", kind="card", png=CARDS / "verify.png", length=20.5, vo=("s7_verify", 0.8)),
        dict(id="end", kind="card", png=CARDS / "end.png", length=11.5, vo=("s8_close", 0.9)),
    ]
    if not short:
        return full
    # 60 s cut: title, the hub split, the partition result, gazebo, end. Voice: the key sentences only.
    pick = {r["id"]: r for r in full}
    return [
        dict(pick["title"], length=10.0),
        dict(pick["hub"]),
        dict(pick["partition"], clips=[(TJ / "scene_partition.mp4", 30.0, 44.0)], length=14.0, vo=("s4b_short", 0.3)),
        dict(pick["end"]),
    ]


def build_segment(r):
    SEG.mkdir(parents=True, exist_ok=True)
    # the key covers the recipe and every input file's modification time, so a re-rendered card or clip rebuilds
    def stamp(o):
        return f"{o}@{o.stat().st_mtime_ns}" if isinstance(o, pathlib.Path) and o.exists() else str(o)
    vo_path = VO / f"{r['vo'][0]}.mp3"
    key = hashlib.sha256((json.dumps(r, default=stamp, sort_keys=True) + stamp(vo_path)).encode()).hexdigest()[:12]
    out = SEG / f"{r['id']}_{key}.mp4"
    if out.exists():
        return out, dur(out)
    vo_file = VO / f"{r['vo'][0]}.mp3"
    vo_len = dur(vo_file)
    tmp = SEG / f"{r['id']}_video.mp4"
    xf = 0.35  # dissolve between clips inside a segment
    if r["kind"] == "card":
        length = r["length"]
        ff(["-loop", "1", "-framerate", str(FPS), "-t", f"{length}", "-i", str(r["png"]),
            "-vf", "format=yuv420p", "-c:v", "h264_nvenc", "-cq", "18", "-r", str(FPS), str(tmp)])
    else:
        def chain(clips, w=1920, h=1080):
            ins, filt, labels = [], [], []
            for i, (f, a, b) in enumerate(clips):
                ins += ["-ss", f"{a}", "-t", f"{b - a}", "-i", str(f)]
                filt.append(f"[{i}:v]scale={w}:{h},fps={FPS},format=yuv420p,setpts=PTS-STARTPTS[c{i}]")
                labels.append(f"c{i}")
            cur, t = labels[0], clips[0][2] - clips[0][1]
            for i in range(1, len(labels)):
                filt.append(f"[{cur}][{labels[i]}]xfade=transition=fade:duration={xf}:offset={t - xf:.3f}[x{i}]")
                cur = f"x{i}"
                t += (clips[i][2] - clips[i][1]) - xf
            return ins, filt, cur, t
        if r["kind"] == "split":
            li, lf, lcur, lt = chain(r["left"], 960, 540)
            ri, rf, rcur, _ = chain(r["right"], 960, 540)
            n = len(r["left"])
            rf = [re.sub(r"\[(\d+):v\]", lambda m: f"[{int(m.group(1)) + n}:v]", x).replace("[c", "[r").replace("[x", "[y") for x in rf]
            rcur = rcur.replace("c", "r", 1) if rcur.startswith("c") else rcur.replace("x", "y", 1)
            base = lf + rf + [f"color=c=0x121614:s=1920x1080:r={FPS}:d={lt:.3f}[bg]",
                              f"[bg][{lcur}]overlay=0:270[b1]", f"[b1][{rcur}]overlay=960:270[base]"]
            ins, filt, cur, length = li + ri, base, "base", lt
        else:
            ins, filt, cur, length = chain(r["clips"])
        k = len(ins) // 6
        for j, (png, a, b) in enumerate(r.get("overlays", [])):
            ins += ["-i", str(png)]
            filt.append(f"[{cur}][{k + j}:v]overlay=0:0:enable='between(t,{a},{b})'[o{j}]")
            cur = f"o{j}"
        filt.append(f"[{cur}]fade=t=in:st=0:d=0.3,fade=t=out:st={length - 0.35:.3f}:d=0.35,format=yuv420p[v]")
        ff(ins + ["-filter_complex", ";".join(filt), "-map", "[v]", "-c:v", "h264_nvenc", "-cq", "18", "-preset", "p5",
                  "-r", str(FPS), "-t", f"{length:.3f}", str(tmp)])
    length = dur(tmp)
    off = r["vo"][1]
    if off + vo_len > length - 0.2:
        print(f"  warning: {r['id']} voice {vo_len:.1f}s + offset {off}s runs past the picture ({length:.1f}s)")
    if r["kind"] == "card":
        # cards fade at the edges too
        ff(["-i", str(tmp), "-vf", f"fade=t=in:st=0:d=0.4,fade=t=out:st={length - 0.4:.3f}:d=0.4", "-c:v", "h264_nvenc",
            "-cq", "18", str(tmp.with_name(tmp.stem + "_f.mp4"))])
        tmp = tmp.with_name(tmp.stem + "_f.mp4")
    ff(["-i", str(tmp), "-i", str(vo_file), "-filter_complex",
        f"[1:a]adelay={int(off * 1000)}|{int(off * 1000)},apad,atrim=0:{length:.3f},aresample=48000,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[a]", "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-t", f"{length:.3f}", str(out)])
    return out, length


def srt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    narr = {s["id"]: s["text"] for s in json.loads((V / "script" / "narration.json").read_text(encoding="utf-8"))["segments"]}
    parts, timeline, subs, t = [], [], [], 0.0
    for r in recipes(a.short):
        path, length = build_segment(r)
        parts.append(path)
        sid, off = r["vo"]
        vo_len = dur(VO / f"{sid}.mp3")
        # subtitles: split the segment's narration into sentences, timed by length
        sentences = [s.strip() for s in re.split(r"(?<=[.:!?])\s+", narr.get(sid, "")) if s.strip()]
        total = sum(len(s) for s in sentences) or 1
        st = t + off
        for s in sentences:
            d = vo_len * len(s) / total
            subs.append((st, st + d, s))
            st += d
        timeline.append({"segment": r["id"], "start_s": round(t, 2), "length_s": round(length, 2), "voice": sid,
                         "sources": [str(c[0].name) + f" {c[1]}-{c[2]}s" for c in r.get("clips", r.get("left", []))]})
        print(f"{r['id']:<10} {t:6.1f}s  +{length:5.1f}s")
        t += length
    name = "pact_video_60s" if a.short else "pact_video"
    lst = OUT / f"{name}_concat.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    # re-encode the join: segments differ in timebase (stills vs clips), and a stream copy would carry the jumps
    ff(["-f", "concat", "-safe", "0", "-i", str(lst), "-vf", f"fps={FPS},format=yuv420p", "-c:v", "h264_nvenc",
        "-preset", "p6", "-cq", "19", "-b:v", "0", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart", str(OUT / f"{name}.mp4")])
    # sharing copy: x264 with a capped rate (the master above is near-lossless and large)
    ff(["-i", str(OUT / f"{name}.mp4"), "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-maxrate", "8M",
        "-bufsize", "16M", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
        str(OUT / f"{name}_share.mp4")])
    (OUT / f"{name}.srt").write_text("".join(f"{i + 1}\n{srt_time(a0)} --> {srt_time(b0)}\n{txt}\n\n"
                                             for i, (a0, b0, txt) in enumerate(subs)), encoding="utf-8")
    (OUT / f"{name}_timeline.json").write_text(json.dumps(timeline, indent=1), encoding="utf-8")
    print(f"{name}.mp4: {t:.1f}s")


if __name__ == "__main__":
    main()
