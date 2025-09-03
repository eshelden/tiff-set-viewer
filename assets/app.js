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
   4) { images: ["Cnt-0001.jpg", ...] }
--------------------------------------------------------- */
async function loadManifestList(basePath) {
    try {
        const res = await fetch(`${basePath}/manifest.json`, { cache: 'no-store' });
        if (!res.ok) return null;
        const data = await res.json();

        if (Array.isArray(data)) {
            // Use entries as-is (they must include extension)
            return data;
        }
        if (data && Array.isArray(data.basenames)) {
            // If you still support basenames, add a warning or error
            console.warn("Manifest uses 'basenames', but all entries should now include extensions.");
            return data.basenames; // Or throw an error if you want to enforce extensions
        }
        if (data && Array.isArray(data.images)) {
            // Use entries as-is (they must include extension)
            return data.images;
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

// --- Add these global variables near your other TIFF globals ---
let panX = 0; // Center of view in image coordinates (x)
let panY = 0; // Center of view in image coordinates (y)
let isPanning = false;
let lastMouseX = 0, lastMouseY = 0;

// Channel toggle state: [R, G, B]
let channelEnabled = [true, true, true];

let rasterImage = null; // For JPEG/PNG images
let maskedRasterCanvas = null;
let lastRasterChannels = [true, true, true];

let maskedTiffCanvas = null;
let lastTiffChannels = [true, true, true];
//#############################################################
function updateChannelButtons() {
    const redBtn = document.getElementById("toggle-red");
    const greenBtn = document.getElementById("toggle-green");
    const blueBtn = document.getElementById("toggle-blue");
    if (redBtn) redBtn.classList.toggle("off", !channelEnabled[0]);
    if (greenBtn) greenBtn.classList.toggle("off", !channelEnabled[1]);
    if (blueBtn) blueBtn.classList.toggle("off", !channelEnabled[2]);
}
//#############################################################

function clampPan(pan, imgSize, viewSize, zoom) {
    const halfView = viewSize / (2 * zoom);
    if (imgSize * zoom < viewSize) {
        // Image is smaller than view, keep centered
        return imgSize / 2;
    }
    return Math.max(halfView, Math.min(imgSize - halfView, pan));
}

// --- Updated drawTIFFToCanvas with panning and clamping ---
function drawTIFFToCanvas(canvas, zoom = 1.0) {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    panX = clampPan(panX, tiffImageWidth, canvas.width, zoom);
    panY = clampPan(panY, tiffImageHeight, canvas.height, zoom);

    const imgW = tiffImageWidth * zoom;
    const imgH = tiffImageHeight * zoom;
    const centerX = panX * zoom;
    const centerY = panY * zoom;
    const offsetX = canvas.width / 2 - centerX;
    const offsetY = canvas.height / 2 - centerY;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (tiffImageData) {
        // Only re-generate masked canvas if channels or image changed
        if (
            !maskedTiffCanvas ||
            lastTiffChannels[0] !== channelEnabled[0] ||
            lastTiffChannels[1] !== channelEnabled[1] ||
            lastTiffChannels[2] !== channelEnabled[2]
        ) {
            maskedTiffCanvas = document.createElement('canvas');
            maskedTiffCanvas.width = tiffImageWidth;
            maskedTiffCanvas.height = tiffImageHeight;
            const ctxOff = maskedTiffCanvas.getContext('2d');
            let imgData = tiffImageData;

            // Apply channel masking if RGB
            if (imgData && imgData.data.length === tiffImageWidth * tiffImageHeight * 4) {
                const d = new Uint8ClampedArray(imgData.data); // copy
                for (let i = 0; i < d.length; i += 4) {
                    if (!channelEnabled[0]) d[i] = 0;     // R
                    if (!channelEnabled[1]) d[i + 1] = 0; // G
                    if (!channelEnabled[2]) d[i + 2] = 0; // B
                }
                imgData = new ImageData(d, tiffImageWidth, tiffImageHeight);
            }
            ctxOff.putImageData(imgData, 0, 0);
            lastTiffChannels = [...channelEnabled];
        }
        ctx.drawImage(
            maskedTiffCanvas,
            0, 0, tiffImageWidth, tiffImageHeight,
            offsetX, offsetY, imgW, imgH
        );
    } else if (rasterImage) {
        // Only re-generate masked canvas if channels or image changed
        if (
            !maskedRasterCanvas ||
            lastRasterChannels[0] !== channelEnabled[0] ||
            lastRasterChannels[1] !== channelEnabled[1] ||
            lastRasterChannels[2] !== channelEnabled[2]
        ) {
            maskedRasterCanvas = document.createElement('canvas');
            maskedRasterCanvas.width = tiffImageWidth;
            maskedRasterCanvas.height = tiffImageHeight;
            const ctxOff = maskedRasterCanvas.getContext('2d');
            ctxOff.drawImage(rasterImage, 0, 0, tiffImageWidth, tiffImageHeight);

            let imgData = ctxOff.getImageData(0, 0, tiffImageWidth, tiffImageHeight);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
                if (!channelEnabled[0]) d[i] = 0;     // R
                if (!channelEnabled[1]) d[i + 1] = 0; // G
                if (!channelEnabled[2]) d[i + 2] = 0; // B
            }
            ctxOff.putImageData(imgData, 0, 0);
            lastRasterChannels = [...channelEnabled];
        }
        ctx.drawImage(
            maskedRasterCanvas,
            0, 0, tiffImageWidth, tiffImageHeight,
            offsetX, offsetY, imgW, imgH
        );
    }
}

async function renderTIFFToCanvas(url, canvas, zoom = 1.0) {
    rasterImage = null; // Clear any previous JPEG/PNG image
    maskedTiffCanvas = null;
    lastTiffChannels = [true, true, true];
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
    // Always strip extension and add .jpg for thumbs
    const toJpg = (name) => name.replace(/\.[^.]+$/, ".jpg");
    set.images.forEach((imgName, idx) => {
        // Log before and after conversion for debugging
        //console.log("Thumb original:", imgName);
        const thumbFile = toJpg(imgName);
        //console.log("Thumb for thumbnail:", thumbFile);

        const el = document.createElement("button");
        el.className = "thumb" + (idx + 1 === activeIndex ? " active" : "");
        el.title = imgName;

        const thumb = document.createElement("img");
        thumb.alt = imgName;
        thumb.loading = (idx < 24) ? "eager" : "lazy";
        thumb.decoding = "async";
        thumb.style.visibility = "hidden";
        thumb.width = 256; thumb.height = 256;

        const thumbsPath = `${set.basePath}/thumbs/${thumbFile}`;
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

    const canvas = document.getElementById("tiff-canvas");
    const filenameLabel = document.getElementById("filename");
    const thumbs = document.getElementById("thumbs");
    const setTitle = document.getElementById("set-title");
    const copyBtn = document.getElementById("copy-link");
    const srcBtn = document.getElementById("download-source");
    const copied = document.getElementById("copied");

    // Zoom controls
    const zoomInBtn = document.getElementById("zoom-in");
    const zoomOutBtn = document.getElementById("zoom-out");
    const zoomLabel = document.getElementById("zoom-label");
    const zoomResetBtn = document.getElementById("zoom-reset");

    function updateZoomLabel() {
        if (zoomLabel) zoomLabel.textContent = `${Math.round(tiffZoom * 100)}%`;
    }

    function zoomAtCanvasCenter(newZoom) {
        const canvas = document.getElementById("tiff-canvas");
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        // Calculate the image coordinate currently at the center of the canvas
        const imgX = (cx - (canvas.width / 2 - panX * tiffZoom)) / tiffZoom;
        const imgY = (cy - (canvas.height / 2 - panY * tiffZoom)) / tiffZoom;
        // Now, after zoom, set panX/panY so that this image coordinate is still at the center
        tiffZoom = newZoom;
        panX = imgX;
        panY = imgY;
        drawTIFFToCanvas(canvas, tiffZoom);
        updateZoomLabel();
    }

    // --- Panning state ---
    let isPanning = false;
    let lastMouseX = 0, lastMouseY = 0;

    // --- Mouse events for panning ---
    canvas.addEventListener('mousedown', (e) => {
        isPanning = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        const dx = (e.clientX - lastMouseX) / tiffZoom;
        const dy = (e.clientY - lastMouseY) / tiffZoom;
        panX -= dx;
        panY -= dy;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        drawTIFFToCanvas(canvas, tiffZoom);
    });
    window.addEventListener('mouseup', () => {
        isPanning = false;
        canvas.style.cursor = '';
    });

    canvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        const zoomFactor = 1.15;
        let newZoom = tiffZoom;
        if (e.deltaY < 0) {
            newZoom = Math.min(tiffZoom * zoomFactor, 8.0);
        } else if (e.deltaY > 0) {
            newZoom = Math.max(tiffZoom / zoomFactor, 0.1);
        }
        if (newZoom === tiffZoom) return; // No change

        // Get mouse position relative to canvas
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Calculate the image coordinates under the mouse before zoom
        const imgX = (mouseX - (canvas.width / 2 - panX * tiffZoom)) / tiffZoom;
        const imgY = (mouseY - (canvas.height / 2 - panY * tiffZoom)) / tiffZoom;

        // After zoom, adjust pan so the same image point stays under the cursor
        panX = ((canvas.width / 2 - mouseX) / newZoom) + imgX;
        panY = ((canvas.height / 2 - mouseY) / newZoom) + imgY;
        tiffZoom = newZoom;

        drawTIFFToCanvas(canvas, tiffZoom);
        updateZoomLabel();
    }, { passive: false });


    // --- Pinch to zoom (touch) ---
    let lastTouchDist = null;
    let lastTouchCenter = null;
    let pinchActive = false; // Add this flag

    canvas.addEventListener('touchstart', function (e) {
        if (e.touches.length === 2) {
            pinchActive = true;
            // Calculate initial distance and center
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            lastTouchDist = Math.hypot(dx, dy);
            lastTouchCenter = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
        } else if (e.touches.length === 1) {
            // Only start pan if not just finishing a pinch
            if (!pinchActive) {
                lastPanTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', function (e) {
        if (e.touches.length === 2 && lastTouchDist !== null) {
            e.preventDefault();
            pinchActive = true;
            // Calculate new distance and center
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const newDist = Math.hypot(dx, dy);
            const newCenter = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };

            // Zoom factor
            const zoomFactor = newDist / lastTouchDist;
            let newZoom = tiffZoom * zoomFactor;
            newZoom = Math.max(0.1, Math.min(8.0, newZoom));
            if (newZoom === tiffZoom) return;

            // Center of pinch in canvas coordinates
            const rect = canvas.getBoundingClientRect();
            const centerX = newCenter.x - rect.left;
            const centerY = newCenter.y - rect.top;

            // Image coordinates under pinch center before zoom
            const imgX = (centerX - (canvas.width / 2 - panX * tiffZoom)) / tiffZoom;
            const imgY = (centerY - (canvas.height / 2 - panY * tiffZoom)) / tiffZoom;

            // After zoom, adjust pan so the same image point stays under the pinch center
            panX = ((canvas.width / 2 - centerX) / newZoom) + imgX;
            panY = ((canvas.height / 2 - centerY) / newZoom) + imgY;
            tiffZoom = newZoom;

            drawTIFFToCanvas(canvas, tiffZoom);
            updateZoomLabel();

            // Update for next move
            lastTouchDist = newDist;
            lastTouchCenter = newCenter;
        } else if (e.touches.length === 1 && lastPanTouch && !pinchActive) {
            e.preventDefault();
            // Single-finger pan only if not just finishing a pinch
            const dx = (e.touches[0].clientX - lastPanTouch.x) / tiffZoom;
            const dy = (e.touches[0].clientY - lastPanTouch.y) / tiffZoom;
            panX -= dx;
            panY -= dy;
            lastPanTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            drawTIFFToCanvas(canvas, tiffZoom);
        }
    }, { passive: false });

    canvas.addEventListener('touchend', function (e) {
        if (e.touches.length < 2) {
            lastTouchDist = null;
            lastTouchCenter = null;
            pinchActive = false; // Reset pinch flag
            // Prevent immediate pan after pinch by resetting lastPanTouch
            lastPanTouch = null;
        }
        if (e.touches.length === 0) {
            lastPanTouch = null;
        }
    }, { passive: false });

    // --- Single-finger pan (touch) ---
    let lastPanTouch = null;
    canvas.addEventListener('touchstart', function (e) {
        if (e.touches.length === 1) {
            lastPanTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', function (e) {
        if (e.touches.length === 1 && lastPanTouch) {
            e.preventDefault();
            const dx = (e.touches[0].clientX - lastPanTouch.x) / tiffZoom;
            const dy = (e.touches[0].clientY - lastPanTouch.y) / tiffZoom;
            panX -= dx;
            panY -= dy;
            lastPanTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            drawTIFFToCanvas(canvas, tiffZoom);
        }
    }, { passive: false });

    canvas.addEventListener('touchend', function (e) {
        if (e.touches.length === 0) {
            lastPanTouch = null;
        }
    }, { passive: false });
    //#############################################################

    // --- On zoom reset, also center pan ---
    if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => {
        tiffZoom = tiffFitZoom;
        panX = tiffImageWidth / 2;
        panY = tiffImageHeight / 2;
        drawTIFFToCanvas(canvas, tiffZoom);
        updateZoomLabel();
    });

    if (zoomInBtn) zoomInBtn.addEventListener("click", () => {
        const newZoom = Math.min(tiffZoom * 1.25, 8.0);
        zoomAtCanvasCenter(newZoom);
    });
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => {
        const newZoom = Math.max(tiffZoom / 1.25, 0.1);
        zoomAtCanvasCenter(newZoom);
    });

    if (setTitle) setTitle.textContent = set.title;

    function flash(msg) {
        if (!copied) return;
        copied.textContent = msg;
        setTimeout(() => copied.textContent = "", 1400);
    }

    let thumbsBuilt = false;
    let lastActionWasTile = false;

    // --- On image load or reset, center the image ---
    async function loadCurrent() {
    const relPath = set.basePath.replace(/\/+$/, '') + '/' + set.images[imgIndex - 1];
    if (filenameLabel) filenameLabel.textContent = relPath;

    const ext = relPath.split('.').pop().toLowerCase();

    try {
        if (ext === 'tif' || ext === 'tiff') {
            await renderTIFFToCanvas(relPath, canvas, 1.0);
            tiffFitZoom = fitImageToCanvas(canvas, tiffImageWidth, tiffImageHeight);
            tiffZoom = tiffFitZoom;
            panX = tiffImageWidth / 2;
            panY = tiffImageHeight / 2;
        } else if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
            await renderImageToCanvas(relPath, canvas);
            // tiffFitZoom, tiffZoom, panX, panY are set in renderImageToCanvas
        } else {
            throw new Error("Unsupported file type: " + ext);
        }

        channelEnabled = [true, true, true];
        updateChannelButtons();

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
    if (prevBtn) prevBtn.addEventListener("click", () => { lastActionWasTile = false; go(-1); });
    if (nextBtn) nextBtn.addEventListener("click", () => { lastActionWasTile = false; go(1); });

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
            const relPath = set.basePath.replace(/\/+$/, '') + '/' + set.images[imgIndex - 1];
            const a = document.createElement('a');
            a.href = relPath;
            a.download = relPath.split('/').pop();
            document.body.appendChild(a);
            a.click();
            a.remove();
            flash("Downloading source TIFF...");
        });
    }

    //##########################################################################
    //Code to initialize channel toggle buttons
    const redBtn = document.getElementById("toggle-red");
    const greenBtn = document.getElementById("toggle-green");
    const blueBtn = document.getElementById("toggle-blue");

    function updateChannelButtons() {
        if (redBtn) redBtn.classList.toggle("off", !channelEnabled[0]);
        if (greenBtn) greenBtn.classList.toggle("off", !channelEnabled[1]);
        if (blueBtn) blueBtn.classList.toggle("off", !channelEnabled[2]);
    }

    if (redBtn) redBtn.addEventListener("click", () => {
        channelEnabled[0] = !channelEnabled[0];
        drawTIFFToCanvas(canvas, tiffZoom);
        updateChannelButtons();
    });
    if (greenBtn) greenBtn.addEventListener("click", () => {
        channelEnabled[1] = !channelEnabled[1];
        drawTIFFToCanvas(canvas, tiffZoom);
        updateChannelButtons();
    });
    if (blueBtn) blueBtn.addEventListener("click", () => {
        channelEnabled[2] = !channelEnabled[2];
        drawTIFFToCanvas(canvas, tiffZoom);
        updateChannelButtons();
    });

    // Call once after image load
    updateChannelButtons();
    //##########################################################################

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

async function renderImageToCanvas(url, canvas) {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        img.onload = function () {
            tiffImageWidth = img.naturalWidth;
            tiffImageHeight = img.naturalHeight;
            tiffImageData = null; // Not used for JPEG/PNG
            rasterImage = img;
            maskedRasterCanvas = null;
            lastRasterChannels = [true, true, true];    // Store the loaded image

            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;

            // Calculate fit zoom and center pan
            tiffFitZoom = fitImageToCanvas(canvas, tiffImageWidth, tiffImageHeight);
            tiffZoom = tiffFitZoom;
            panX = tiffImageWidth / 2;
            panY = tiffImageHeight / 2;

            // Draw image
            drawTIFFToCanvas(canvas, tiffZoom);

            resolve();
        };
        img.onerror = reject;
        img.src = url;
    });
}

