#!/usr/bin/env python3
import os
import sys
import json
import subprocess
from pathlib import Path

def find_imagemagick_cmd():
    """Prefer 'magick' (Windows/newer IM). Fall back to 'convert' if needed."""
    def _exists(cmd):
        try:
            out = subprocess.run([cmd, "-version"], capture_output=True, text=True)
            return out.returncode == 0
        except Exception:
            return False

    if _exists("magick"):
        return ("magick", "magick")
    if _exists("convert"):
        try:
            out = subprocess.run(["convert", "-version"], capture_output=True, text=True)
            if "ImageMagick" in (out.stdout + out.stderr):
                return ("convert", "convert")
        except Exception:
            pass
    return (None, None)

def run_cmd(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(args)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result

def identify_num_pages(im_cmd, tif_path: Path) -> int:
    """Return number of pages (scenes) in the TIFF via `identify -format %n`."""
    args = [im_cmd, "identify", "-format", "%n", str(tif_path)] if im_cmd == "magick" \
        else [im_cmd, str(tif_path), "-format", "%n", "info:"]
    out = run_cmd(args)
    txt = out.stdout.strip() or out.stderr.strip()
    try:
        return int(txt)
    except Exception:
        # If parsing fails, assume single page
        return 1

def safe_replace(original: Path, newfile: Path):
    """Atomically replace original with newfile, keeping a .bak (removed if possible)."""
    backup = original.with_suffix(original.suffix + ".bak")
    if backup.exists():
        try:
            backup.unlink()
        except Exception:
            pass
    try:
        original.replace(backup)
    except FileNotFoundError:
        # If original didn't exist, that's fine
        pass
    newfile.replace(original)
    try:
        backup.unlink()
    except Exception:
        pass

def combine_channels_if_needed(im_cmd, mode, in_path: Path) -> Path:
    """
    If TIFF has >=2 pages, build an RGB composite:
      - 3+ pages: [0]=R, [1]=G, [2]=B
      - 2 pages:  [0]=R, [1]=G, duplicate [1] for B
    Returns the path to the (possibly) new composite image. If no combine needed,
    returns the original in_path.
    """
    n_pages = identify_num_pages(im_cmd, in_path)
    if n_pages <= 1:
        return in_path  # nothing to combine

    temp_combined = in_path.with_suffix(in_path.suffix + ".rgb.tmp.tif")
    if temp_combined.exists():
        try:
            temp_combined.unlink()
        except Exception:
            pass

    if n_pages >= 3:
        # magick in[0] in[1] in[2] -combine out
        args = [im_cmd] if mode == "magick" else [im_cmd]
        args += [
            str(in_path) + "[0]",
            str(in_path) + "[1]",
            str(in_path) + "[2]",
            "-combine",
            str(temp_combined),
        ]
    else:  # n_pages == 2
        # Use [0]=R, [1]=G, duplicate [1] as B
        args = [im_cmd] if mode == "magick" else [im_cmd]
        args += [
            str(in_path) + "[0]",
            str(in_path) + "[1]",
            str(in_path) + "[1]",
            "-combine",
            str(temp_combined),
        ]

    run_cmd(args)
    return temp_combined

def lzw_compress_tiff_inplace(im_cmd, mode, in_path: Path):
    """
    LZW-compress the given TIFF in-place (via temp swap). If in_path is a temp composite,
    we still output to a temp and then replace the *original* file upstream.
    """
    temp_out = in_path.with_suffix(in_path.suffix + ".lzw.tmp.tif")
    if temp_out.exists():
        try:
            temp_out.unlink()
        except Exception:
            pass

    args = [im_cmd] if mode == "magick" else [im_cmd]
    args += [str(in_path), "-compress", "LZW", str(temp_out)]
    run_cmd(args)
    return temp_out

def make_thumbnail(im_cmd, mode, in_path: Path, out_jpg: Path):
    """
    Create a 256x256 JPG thumbnail, preserving aspect ratio and center-cropping to exact size.
    """
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    args = [im_cmd] if mode == "magick" else [im_cmd]
    args += [
        str(in_path),
        "-thumbnail", "256x256^",
        "-gravity", "center",
        "-extent", "256x256",
        str(out_jpg),
    ]
    run_cmd(args)

def natural_sort_key(s: str):
    import re
    return [int(t) if t.isdigit() else t.lower() for t in re.findall(r"\d+|\D+", s)]

def main():
    root = Path.cwd()
    thumbs_dir = root / "thumbs"
    thumbs_dir.mkdir(exist_ok=True)

    im_cmd, mode = find_imagemagick_cmd()
    if not im_cmd:
        print(
            "ERROR: ImageMagick not found. Install it and ensure 'magick' (preferred) or 'convert' is in your PATH.",
            file=sys.stderr,
        )
        sys.exit(1)

    tiff_exts = {".tif", ".tiff"}
    tiff_files = [
        p for p in root.iterdir()
        if p.is_file() and p.suffix.lower() in tiff_exts and p.parent != thumbs_dir
    ]

    if not tiff_files:
        print("No TIFF files found in this folder.")
        # Still write an empty manifest to keep downstream happy
        manifest_path = root / "manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"basenames": []}, f, indent=2)
        print(f"Manifest written: {manifest_path}")
        return

    print(f"Found {len(tiff_files)} TIFF(s). Processing...")

    basenames = []

    for tiff in sorted(tiff_files, key=lambda p: natural_sort_key(p.stem)):
        base = tiff.stem
        basenames.append(base)
        print(f"\n== {tiff.name} ==")

        try:
            # Step A: combine channels if it looks like a channel stack (>=2 pages)
            combined_path = combine_channels_if_needed(im_cmd, mode, tiff)

            # Step B: LZW compress (in-place replacement of the *original* file)
            temp_lzw = lzw_compress_tiff_inplace(im_cmd, mode, combined_path)

            # Replace original file with compressed output.
            # If we created a composite temp, we still replace the original 'tiff'.
            safe_replace(tiff, temp_lzw)

            # Clean up composite temp file if it exists and isn't the same as original
            if combined_path != tiff and combined_path.exists():
                try:
                    combined_path.unlink()
                except Exception:
                    pass

            # Step C: Make thumbnail from the final (now-compressed) TIFF
            thumb_jpg = thumbs_dir / f"{base}.jpg"
            print(f"[THUMB] {thumb_jpg.relative_to(root)}")
            make_thumbnail(im_cmd, mode, tiff, thumb_jpg)

        except Exception as e:
            print(f"  !! Error processing {tiff.name}: {e}", file=sys.stderr)
            continue

    # Step D: manifest.json
    manifest = {"basenames": basenames}
    manifest_path = root / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest written: {manifest_path}")
    print("Done!")

if __name__ == "__main__":
    main()
