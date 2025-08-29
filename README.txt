# Minimal TIFF Gallery (Copy Link + Download Source)

Two buttons only:
- **Copy link** — copies the current page URL (with `?set=...&img=...`).
- **Download source TIFF** — downloads the exact source `.tif` currently displayed.

## UTIF.js (required for TIFF)
Download UTIF.js into `assets/UTIF.js`:
- jsDelivr: https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js
- unpkg: https://unpkg.com/utif@3.1.0/UTIF.js

## Run locally
```bash
python3 -m http.server 8080
# open http://localhost:8080/index.html
```

## Direct-link to any image
`gallery.html?set=set1&img=2`
