/* ==================== App JS (V2, manifest-only) ====================
   - No probing (no HEAD requests)
   - Requires /images/<set>/manifest.json per set
   - Index reads /data/sets.json for set metadata
====================================================================== */

/* ------------ Utilities ------------ */
async function loadJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function getQueryParam(key) {
  const url = new URL(window.location.href);
  return url.searchParams.get(key);
}

function fitImageToCanvas(canvas, imgWidth, imgHeight) {
    const viewW = canvas.clientWidth;
    const viewH = canvas.clientHeight;
    return Math.min(viewW / imgWidth, viewH / imgHeight, 1.0);
}

/* ------------ Manifest loader (per-set only) ------------
   Supports any of:
   1) ["Cnt-0001","Cnt-0002"]
   2) { basenames: ["Cnt-0001", ...] }
   3) { images: ["Cnt-0001.tif", ...] }
--------------------------------------------------------- */
async function loadManifestList(basePath) {
  try {
    const res = await fetch(`${basePath}/manifest.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();

    if (Array.isArray(data)) {
      if (data.length && /\.[a-z]{2,4}$/i.test(data[0])) {
        return data.map(s => s.replace(/\.(jpg|jpeg|png)$/i, '.tif'));
      }
      return data.map(b => `${b}.tif`);
    }
    if (data && Array.isArray(data.basenames)) {
      return data.basenames.map(b => `${b}.tif`);
    }
    if (data && Array.isArray(data.images)) {
      return data.images.map(s => s.replace(/\.(jpg|jpeg|png)$/i, '.tif'));
    }
  } catch (e) {
    console.warn('Manifest load failed:', e);
  }
  return null;
}

/* ------------ SVG fallback placeholder for cards/thumbs ------------ */
function svgFallbackCard(title) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
    <rect width="100%" height="100%" fill="#0f172a"/>
    <text x="50%" y="50%" fill="#94a3b8" dominant-baseline="middle" text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="20">${title}</text>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* ------------------- Index (landing) ---------------------- */
async function initIndex() {
  try {
    const sets = await loadJSON("data/sets.json");
    const grid = document.getElementById("sets-grid");
    if (!grid) return;
    grid.innerHTML = "";
    sets.forEach(set => {
      const card = document.createElement("div"); card.className = "card";
      const a = document.createElement("a");
      a.href = `gallery.html?set=${encodeURIComponent(set.id)}&img=1`;
      a.setAttribute("aria-label", `Open ${set.title}`);

      const img = document.createElement("img");
      img.alt = set.title; img.loading = "lazy";
      img.src = set.thumbnail || svgFallbackCard(set.title);
      img.onerror = () => { img.src = svgFallbackCard(set.title); };

      const body = document.createElement("div"); body.className = "card-body";
      const h2 = document.createElement("h2"); h2.textContent = set.title;
      const p = document.createElement("p"); p.textContent = set.description || "Click to view";

      body.appendChild(h2); body.appendChild(p);
      a.appendChild(img); a.appendChild(body);
      card.appendChild(a); grid.appendChild(card);
    });
  } catch (e) {
    console.error("Index init error:", e);
  }
}

/* ---------------- TIFF Rendering (viewer) ----------------- */
// Global variables for TIFF image and zoom
let tiffImageData = null;
let tiffImageWidth = 0;
let tiffImageHeight = 0;
let tiffZoom = 1.0;
let tiffFitZoom = 1.0; // Add this near your other global TIFF variables

function drawTIFFToCanvas(canvas, zoom = 1.0) {
    if (!tiffImageData) return;
    // Set internal pixel size to match display size for sharpness
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    const ctx = canvas.getContext("2d");

    // Calculate scaled image size
    const imgW = tiffImageWidth * zoom;
    const imgH = tiffImageHeight * zoom;

    // Center the image
    const offsetX = (canvas.width - imgW) / 2;
    const offsetY = (canvas.height - imgH) / 2;

    // Draw
    const off = document.createElement('canvas');
    off.width = tiffImageWidth;
    off.height = tiffImageHeight;
    off.getContext('2d').putImageData(tiffImageData, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, tiffImageWidth, tiffImageHeight, offsetX, offsetY, imgW, imgH);
}

async function renderTIFFToCanvas(url, canvas, zoom = 1.0) {
  // 1. Fetch the TIFF file as an ArrayBuffer
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = await resp.arrayBuffer();

  // 2. Check for UTIF.js presence (required for decoding TIFF)
  if (typeof UTIF === "undefined") {
    // Draw an error message on the canvas if UTIF.js is missing
    const ctx = canvas.getContext("2d");
    canvas.width = 1200; canvas.height = 140;
    ctx.fillStyle = "#111827"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = "#f9fafb"; ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("UTIF.js not found. Place assets/UTIF.js and ensure it loads before assets/app.js.", 14, 70);
    throw new Error("UTIF.js missing");
  }

  // 3. Decode the TIFF file into IFDs (Image File Directories)
  const ifds = UTIF.decode(buf);
  if (!ifds || !ifds.length) throw new Error("No IFDs found (unsupported/corrupt TIFF).");

  // 4. Decode image data for each IFD (TIFF can have multiple images/pages)
  if (typeof UTIF.decodeImages === "function") {
    UTIF.decodeImages(buf, ifds);
  } else if (typeof UTIF.decodeImage === "function") {
    for (const ifd of ifds) UTIF.decodeImage(buf, ifd);
  } else {
    throw new Error("UTIF.decodeImage(s) not available in this UTIF build.");
  }

  // 5. Get the first image/page
  const first = ifds[0];
  const rgba = UTIF.toRGBA8(first); // Convert to RGBA pixel data
  const w = first.width, h = first.height;
  if (!w || !h) throw new Error("Decoded image has no width/height.");

  // Store for later redraws
  tiffImageWidth = w;
  tiffImageHeight = h;
  tiffImageData = new ImageData(new Uint8ClampedArray(rgba), w, h);

  // Draw at current zoom
  drawTIFFToCanvas(canvas, zoom);
}

/* --------------- Gallery (thumbs + copy/download) ----------- */
function buildThumbs(container, set, activeIndex, onSelect) {
  container.innerHTML = "";
  const toJpg = (tif) => tif.replace(/\.tif$/i, ".jpg");
  set.images.forEach((imgName, idx) => {
    const el = document.createElement("button");
    el.className = "thumb" + (idx + 1 === activeIndex ? " active" : "");
    el.title = imgName;

    const thumb = document.createElement("img");
    thumb.alt = imgName;
    thumb.loading = (idx < 24) ? "eager" : "lazy";
    thumb.decoding = "async";
    thumb.style.visibility = "hidden";
    thumb.width = 256; thumb.height = 256;

    const thumbsPath = `${set.basePath}/thumbs/${toJpg(imgName)}`;
    thumb.src = thumbsPath;

    thumb.addEventListener("load", () => { thumb.style.visibility = "visible"; }, { once: true });
    thumb.onerror = () => {
      const fallback = set.thumbnail || svgFallbackCard(imgName);
      thumb.src = fallback;
      thumb.style.visibility = "visible";
    };

    el.appendChild(thumb);
    el.addEventListener("click", () => onSelect(idx + 1));
    container.appendChild(el);
  });
}

function highlightThumbs(container, activeIndex, shouldScroll = false) {
  const kids = container ? Array.from(container.children) : [];
  kids.forEach((el, i) => {
    const isActive = (i + 1) === activeIndex;
    el.classList.toggle("active", isActive);
    if (isActive && shouldScroll) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
}

async function initGallery() {
  const setId = getQueryParam("set");
  let imgIndex = parseInt(getQueryParam("img") || "1", 10);
  if (!Number.isFinite(imgIndex) || imgIndex < 1) imgIndex = 1;

  let sets;
  try {
    sets = await loadJSON("data/sets.json");
  } catch (e) {
    console.error("Failed to load sets.json:", e);
    const t = document.getElementById("set-title");
    if (t) t.textContent = "Error: cannot load sets.json";
    return;
  }
  const set = sets.find(s => s.id === setId);
  if (!set) { const t = document.getElementById("set-title"); if (t) t.textContent = "Set not found"; return; }

  // Manifest required (no probing)
  console.info("[gallery] set:", setId, "basePath:", set.basePath);
  const manifestImages = await loadManifestList(set.basePath);
  if (!manifestImages || !manifestImages.length) {
    const t = document.getElementById("set-title");
    if (t) t.textContent = "No manifest.json or empty manifest in " + set.basePath;
    console.warn("[gallery] Manifest missing or empty at", set.basePath + "/manifest.json");
    return;
  }
  console.info("[gallery] Using manifest with", manifestImages.length, "images");
  set.images = manifestImages;

  const total = set.images.length || 0;
  if (total === 0) { const t = document.getElementById("set-title"); if (t) t.textContent = `${set.title} (no images)`; return; }
  if (imgIndex > total) imgIndex = total;

  const canvas        = document.getElementById("tiff-canvas");
  const filenameLabel = document.getElementById("filename");
  const thumbs        = document.getElementById("thumbs");
  const setTitle      = document.getElementById("set-title");
  const copyBtn       = document.getElementById("copy-link");
  const srcBtn        = document.getElementById("download-source");
  const copied        = document.getElementById("copied");

  // Zoom controls
  const zoomInBtn = document.getElementById("zoom-in");
  const zoomOutBtn = document.getElementById("zoom-out");
  const zoomLabel = document.getElementById("zoom-label");

  function updateZoomLabel() {
    if (zoomLabel) zoomLabel.textContent = `${Math.round(tiffZoom * 100)}%`;
  }

  if (zoomInBtn) zoomInBtn.addEventListener("click", () => {
    tiffZoom = Math.min(tiffZoom * 1.25, 8.0); // max 800%
    drawTIFFToCanvas(canvas, tiffZoom);
    updateZoomLabel();
  });
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => {
    tiffZoom = Math.max(tiffZoom / 1.25, 0.1); // min 10%
    drawTIFFToCanvas(canvas, tiffZoom);
    updateZoomLabel();
  });

  if (setTitle) setTitle.textContent = set.title;

  function flash(msg){
    if (!copied) return;
    copied.textContent = msg;
    setTimeout(()=>copied.textContent="",1400);
  }

  let thumbsBuilt = false;
  let lastActionWasTile = false;

async function loadCurrent() {
    const relPath = set.basePath.replace(/\/+$/, '') + '/' + set.images[imgIndex - 1];
    if (filenameLabel) filenameLabel.textContent = relPath;

    try {
        await renderTIFFToCanvas(relPath, canvas, 1.0); // Always load at 100% to get image size

        // Calculate zoom to fit image in canvas
        // tiffZoom = fitImageToCanvas(canvas, tiffImageWidth, tiffImageHeight);
        tiffFitZoom = fitImageToCanvas(canvas, tiffImageWidth, tiffImageHeight);
        tiffZoom = tiffFitZoom; // Set current zoom to fit on load

        // Draw at the calculated zoom
        drawTIFFToCanvas(canvas, tiffZoom);
        updateZoomLabel();
    } catch (e) {
        console.error("Render error:", e);
        const ctx = canvas.getContext("2d");
        canvas.width = 1200; canvas.height = 140;
        ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#f9fafb"; ctx.font = "16px system-ui, sans-serif";
        ctx.fillText(`Error rendering ${relPath}: ${e && e.message ? e.message : e}`, 14, 70);
    }

    if (!thumbsBuilt) {
        buildThumbs(thumbs, set, imgIndex, (n) => { lastActionWasTile = true; imgIndex = n; loadCurrent(); });
        thumbsBuilt = true;
    } else {
        highlightThumbs(thumbs, imgIndex, lastActionWasTile);
        lastActionWasTile = false;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("img", String(imgIndex));
    history.replaceState({}, "", url.toString());
    document.title = `${set.title} – Image ${imgIndex}/${total}`;
}

  async function go(delta) {
    imgIndex += delta;
    if (imgIndex < 1) imgIndex = 1;
    if (imgIndex > total) imgIndex = total;
    await loadCurrent();
  }

  const prevBtn = document.getElementById("prev-btn");
  const nextBtn = document.getElementById("next-btn");
  const zoomResetBtn = document.getElementById("zoom-reset");
  if (prevBtn) prevBtn.addEventListener("click", () => { lastActionWasTile = false; go(-1); });
  if (nextBtn) nextBtn.addEventListener("click", () => { lastActionWasTile = false; go(1); });

  if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => {
    tiffZoom = tiffFitZoom;
    drawTIFFToCanvas(canvas, tiffZoom);
    updateZoomLabel();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { lastActionWasTile = false; go(-1); }
    if (e.key === "ArrowRight") { lastActionWasTile = false; go(1); }
  });

  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        flash("Link copied!");
      } catch (e) {
        console.error("Copy link failed:", e);
        alert("Copy link failed: " + (e.message || e));
      }
    });
  }

  if (srcBtn) {
    srcBtn.addEventListener("click", () => {
      const relPath = set.basePath.replace(/\/+$/,'') + '/' + set.images[imgIndex - 1];
      const a = document.createElement('a');
      a.href = relPath;
      a.download = relPath.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
      flash("Downloading source TIFF...");
    });
  }

  await loadCurrent();
}

/* ------------------------- Boot --------------------------- */
(async function () {
  const page = (document.body && document.body.dataset && document.body.dataset.page)
    || (document.getElementById('sets-grid') ? 'index'
        : (document.getElementById('thumb-grid') ? 'gallery' : ''));
  try {
    if (page === "index") {
      await initIndex();
    } else if (page === "gallery") {
      await initGallery();
    }
  } catch (e) {
    console.error("Fatal init error:", e);
    const main = document.querySelector("main") || document.body;
    if (main) {
      const div = document.createElement("div");
      div.style.color = "#fca5a5"; div.style.padding = "1rem";
      div.textContent = `Error: ${e && e.message ? e.message : e}`;
      main.prepend(div);
    }
  }
})();
