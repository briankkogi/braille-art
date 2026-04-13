import { useState, useRef, useCallback, useEffect } from "react";

// Braille dot layout per character (2 wide x 4 tall):
//  dot0 dot1
//  dot2 dot3
//  dot4 dot5
//  dot6 dot7
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
const SAMPLE_SCALE = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getBrightness(r, g, b, mode) {
  switch (mode) {
    case "luminance":
      return 0.299 * r + 0.587 * g + 0.114 * b;
    case "lightness":
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    case "average":
      return (r + g + b) / 3;
    case "value":
      return Math.max(r, g, b);
    default:
      return 0.299 * r + 0.587 * g + 0.114 * b;
  }
}

function getDitherLuminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function sampleDotValues(brightness, sampleW, dotGridW, dotGridH, sampleScale) {
  const dotValues = new Float32Array(dotGridW * dotGridH);
  const sampleArea = sampleScale * sampleScale;

  for (let dotY = 0; dotY < dotGridH; dotY++) {
    const sampleY = dotY * sampleScale;

    for (let dotX = 0; dotX < dotGridW; dotX++) {
      const sampleX = dotX * sampleScale;
      let total = 0;

      for (let sy = 0; sy < sampleScale; sy++) {
        const rowOffset = (sampleY + sy) * sampleW + sampleX;

        for (let sx = 0; sx < sampleScale; sx++) {
          total += brightness[rowOffset + sx];
        }
      }

      dotValues[dotY * dotGridW + dotX] = total / sampleArea;
    }
  }

  return dotValues;
}

function addDitherError(pixels, width, height, x, y, errorR, errorG, errorB, factor) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;

  const idx = (y * width + x) * 4;
  pixels[idx] = clamp(pixels[idx] + errorR * factor, 0, 255);
  pixels[idx + 1] = clamp(pixels[idx + 1] + errorG * factor, 0, 255);
  pixels[idx + 2] = clamp(pixels[idx + 2] + errorB * factor, 0, 255);
  pixels[idx + 3] = 255;
}

function ditherRgbPixels(values, width, height, threshold) {
  const dithered = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    dithered[i] = values[i];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const oldR = dithered[idx];
      const oldG = dithered[idx + 1];
      const oldB = dithered[idx + 2];
      const next = getDitherLuminance(oldR, oldG, oldB) > threshold ? 255 : 0;
      const errorR = oldR - next;
      const errorG = oldG - next;
      const errorB = oldB - next;

      dithered[idx] = next;
      dithered[idx + 1] = next;
      dithered[idx + 2] = next;
      dithered[idx + 3] = 255;

      addDitherError(dithered, width, height, x + 1, y, errorR, errorG, errorB, 7 / 16);
      addDitherError(dithered, width, height, x - 1, y + 1, errorR, errorG, errorB, 3 / 16);
      addDitherError(dithered, width, height, x, y + 1, errorR, errorG, errorB, 5 / 16);
      addDitherError(dithered, width, height, x + 1, y + 1, errorR, errorG, errorB, 1 / 16);
    }
  }

  return dithered;
}

function buildBrightnessGrid(pixels, width, height, mode) {
  const bright = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      bright[y * width + x] = getBrightness(
        pixels[idx],
        pixels[idx + 1],
        pixels[idx + 2],
        mode,
      );
    }
  }

  return bright;
}

function getAdaptiveThreshold(cellMean, threshold) {
  return clamp((cellMean + threshold) / 2, 0, 255);
}

function imageToBraille(
  ctx,
  srcImg,
  { threshold, invert, contrast, cols, mode, dither },
) {
  const charW = 2;
  const charH = 4;
  const sampleScale = dither ? 1 : SAMPLE_SCALE;
  const dotGridW = cols * charW;
  const w = srcImg.naturalWidth;
  const h = srcImg.naturalHeight;
  const rows = Math.max(1, Math.round((h / w) * cols * (charW / charH)));
  const dotGridH = rows * charH;
  const canvasW = dotGridW * sampleScale;
  const canvasH = dotGridH * sampleScale;

  ctx.canvas.width = canvasW;
  ctx.canvas.height = canvasH;
  ctx.filter = "none";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.imageSmoothingEnabled = false;
  ctx.filter = `contrast(${contrast})`;
  ctx.drawImage(srcImg, 0, 0, canvasW, canvasH);
  ctx.filter = "none";

  const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
  const pixels = dither ? ditherRgbPixels(imgData.data, canvasW, canvasH, threshold) : imgData.data;

  const bright = buildBrightnessGrid(pixels, canvasW, canvasH, mode);
  const dotValues = sampleDotValues(bright, canvasW, dotGridW, dotGridH, sampleScale);

  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      let code = 0;

      let cellMean = 0;
      for (let dy = 0; dy < charH; dy++) {
        for (let dx = 0; dx < charW; dx++) {
          const px = col * charW + dx;
          const py = row * charH + dy;
          cellMean += dotValues[py * dotGridW + px];
        }
      }
      const adaptiveThreshold = getAdaptiveThreshold(cellMean / DOT_BITS.length, threshold);

      for (let dy = 0; dy < charH; dy++) {
        for (let dx = 0; dx < charW; dx++) {
          const px = col * charW + dx;
          const py = row * charH + dy;
          const b = dotValues[py * dotGridW + px];
          const lit = dither
            ? invert
              ? b > 128
              : b < 128
            : invert
              ? b > adaptiveThreshold
              : b < adaptiveThreshold;
          if (lit) code |= DOT_BITS[dy * charW + dx];
        }
      }
      line += String.fromCodePoint(0x2800 + code);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

const MODES = ["luminance", "lightness", "average"];
const MODE_LABELS = {
  luminance: "perceived",
  lightness: "midtone",
  average: "balanced",
};
const BRAILLE_FONT_STACK = [
  '"Apple Braille"',
  '"Noto Sans Symbols 2"',
  '"Segoe UI Symbol"',
  '"Symbola"',
  '"Courier New"',
  "monospace",
].join(", ");

function useHover() {
  const [hovered, setHovered] = useState(false);
  const bind = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
  return [hovered, bind];
}

function Label({ children }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.25em",
        color: "#999",
        textTransform: "uppercase",
        display: "block",
        marginBottom: 8,
      }}
    >
      {children}
    </span>
  );
}

function Toggle({ value, onChange, label }) {
  const [hovered, hoverBind] = useHover();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>{label}</Label>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        {...hoverBind}
        style={{
          width: 48,
          height: 26,
          borderRadius: 0,
          background: value ? "#fff" : "#1a1a1a",
          border: `2px solid ${value ? "#fff" : hovered ? "#aaa" : "#555"}`,
          cursor: "pointer",
          position: "relative",
          padding: 0,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 3,
            left: value ? 24 : 3,
            width: 16,
            height: 16,
            borderRadius: 0,
            background: value ? "#0a0a0a" : "#666",
          }}
        />
      </button>
      <span style={{ fontSize: 11, fontWeight: 700, color: value ? "#fff" : "#666" }}>
        {value ? "ON" : "OFF"}
      </span>
    </div>
  );
}

export default function BrailleArt() {
  const [result, setResult] = useState("");
  const [threshold, setThreshold] = useState(128);
  const [invert, setInvert] = useState(false);
  const [contrast, setContrast] = useState(1.4);
  const [cols, setCols] = useState(24);
  const [mode, setMode] = useState("luminance");
  const [dither, setDither] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [dropFocused, setDropFocused] = useState(false);
  const [dropHovered, setDropHovered] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const fileInputRef = useRef(null);
  const copyTimeoutRef = useRef(null);
  const sourceUrlRef = useRef("");

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }

      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
      }
    };
  }, []);

  const render = useCallback((img, opts) => {
    if (!canvasRef.current || !img) return;
    const ctx = canvasRef.current.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas context is unavailable");
    }
    setResult(imageToBraille(ctx, img, opts));
  }, []);

  const getOpts = useCallback(
    (overrides = {}) => ({
      threshold,
      invert,
      contrast,
      cols,
      mode,
      dither,
      ...overrides,
    }),
    [threshold, invert, contrast, cols, mode, dither],
  );

  const loadImageSource = useCallback(
    (src, nextFileName) => {
      setError("");
      setCopied(false);
      setIsProcessing(true);
      setFileName(nextFileName || "image");

      const img = new Image();
      img.onerror = () => {
        setError("Could not decode that image. Try another file.");
        setIsProcessing(false);
      };

      img.onload = () => {
        imgRef.current = img;

        window.requestAnimationFrame(() => {
          try {
            render(img, getOpts());
          } catch {
            setError("Could not convert that image. Try another one.");
          } finally {
            setIsProcessing(false);
          }
        });
      };

      img.src = src;
    },
    [getOpts, render],
  );

  const handleFile = useCallback(
    (file, fallbackName = "image") => {
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setError("Please choose an image file.");
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      if (sourceUrlRef.current) {
        URL.revokeObjectURL(sourceUrlRef.current);
      }
      sourceUrlRef.current = objectUrl;
      setPreviewUrl(objectUrl);

      loadImageSource(objectUrl, file.name || fallbackName);
    },
    [loadImageSource],
  );

  useEffect(() => {
    const handlePaste = (event) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      const file = imageItem?.getAsFile();

      if (!file) return;

      event.preventDefault();
      handleFile(file, "pasted image");
    };

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [handleFile]);

  const update = (overrides) => {
    if (overrides.threshold !== undefined) setThreshold(overrides.threshold);
    if (overrides.invert !== undefined) setInvert(overrides.invert);
    if (overrides.contrast !== undefined) setContrast(overrides.contrast);
    if (overrides.cols !== undefined) setCols(overrides.cols);
    if (overrides.mode !== undefined) setMode(overrides.mode);
    if (overrides.dither !== undefined) setDither(overrides.dither);

    if (!imgRef.current) return;

    try {
      setError("");
      render(imgRef.current, getOpts(overrides));
    } catch {
      setError("Could not update the current image.");
    }
  };

  const showCopiedState = useCallback(() => {
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }

    setCopied(true);
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopied(false);
    }, 1800);
  }, []);

  const handleCopy = async () => {
    if (!result) return;

    try {
      setError("");
      await navigator.clipboard.writeText(result);
      showCopiedState();
    } catch {
      setError("Could not copy the output. Select the text and copy it manually.");
    }
  };

  const handleDownload = useCallback(() => {
    if (!result) return;
    const blob = new Blob([result], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "braille-art.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [result]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDropZoneKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openFilePicker();
      }
    },
    [openFilePicker],
  );

  const feedbackText = error
    ? error
    : isProcessing
      ? "processing image..."
      : fileName
        ? "adjust the settings, then copy the result"
        : "drop, paste, or click to upload an image";

  const characterCount = result ? result.length : 0;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#e0e0e0",
        fontFamily: "'Courier New', monospace",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "40px 20px",
      }}
    >
      <style>{`
        @keyframes borderPulse {
          0%, 100% { border-color: #444; }
          50% { border-color: #fff; }
        }
        .braille-mode-btn:hover {
          border-color: #aaa !important;
        }
        .braille-mode-btn:active {
          background: #fff !important;
          color: #0a0a0a !important;
          border-color: #fff !important;
        }
        .braille-copy-btn:hover {
          border-color: #fff !important;
        }
        .braille-download-btn:hover {
          border-color: #fff !important;
        }
        .braille-num-input::-webkit-inner-spin-button,
        .braille-num-input::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .braille-num-input {
          -moz-appearance: textfield;
        }
        .braille-num-input:focus {
          outline: none;
          border-color: #fff !important;
        }
        .braille-num-input:hover {
          border-color: #888 !important;
        }
      `}</style>
      <canvas ref={canvasRef} style={{ display: "none" }} />

      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ fontSize: 14, letterSpacing: "0.3em", color: "#444", marginBottom: 12 }}>
          ⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿
        </div>
        <h1 style={{ margin: 0, fontSize: 36, fontWeight: 700, letterSpacing: "0.2em", color: "#fff" }}>
          BRAILLE ART
        </h1>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.35em", color: "#777", marginTop: 10 }}>
          IMAGE CONVERTER
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files[0]);
        }}
        onClick={openFilePicker}
        onKeyDown={handleDropZoneKeyDown}
        onFocus={() => setDropFocused(true)}
        onBlur={() => setDropFocused(false)}
        role="button"
        tabIndex={0}
        aria-label="Upload an image"
        aria-describedby="upload-feedback"
        aria-busy={isProcessing}
        onMouseEnter={() => setDropHovered(true)}
        onMouseLeave={() => setDropHovered(false)}
        style={{
          width: "100%",
          maxWidth: 520,
          border: `2px solid ${dragging ? "#fff" : dropFocused ? "#aaa" : dropHovered ? "#888" : "#444"}`,
          padding: "32px 20px",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "#151515" : "transparent",
          marginBottom: 12,
          boxSizing: "border-box",
          animation: isProcessing ? "borderPulse 1s ease-in-out infinite" : "none",
        }}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Preview"
            style={{
              width: 80,
              height: 80,
              objectFit: "cover",
              border: "2px solid #444",
              marginBottom: 8,
              display: "block",
              marginLeft: "auto",
              marginRight: "auto",
            }}
          />
        ) : (
          <div style={{ fontSize: 30, marginBottom: 8, opacity: 0.5 }}>⣿⣿⣿</div>
        )}
        <div style={{ fontSize: 13, fontWeight: 700, color: "#888", letterSpacing: "0.05em" }}>
          {fileName || "DROP IMAGE OR CLICK TO UPLOAD"}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          aria-label="Upload image file"
          style={{ display: "none" }}
          onChange={(e) => {
            handleFile(e.target.files[0]);
            e.target.value = "";
          }}
        />
      </div>

      <div
        id="upload-feedback"
        role={error ? "alert" : "status"}
        aria-live="polite"
        style={{
          width: "100%",
          maxWidth: 520,
          marginBottom: 24,
          color: error ? "#ff6b6b" : "#777",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {feedbackText}
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 520,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 20,
          marginBottom: 24,
        }}
      >
        <Toggle label="Invert" value={invert} onChange={(v) => update({ invert: v })} />
        <Toggle label="Dither" value={dither} onChange={(v) => update({ dither: v })} />
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 520,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 20,
          marginBottom: 24,
        }}
      >
        <div>
          <Label>Threshold — {threshold}</Label>
          <input
            type="range"
            min={20}
            max={220}
            value={threshold}
            aria-label="Threshold"
            onChange={(e) => update({ threshold: Number(e.target.value) })}
            style={{ accentColor: "#fff", width: "100%" }}
          />
        </div>
        <div>
          <Label>Contrast — {contrast.toFixed(2)}×</Label>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={contrast}
            aria-label="Contrast"
            onChange={(e) => update({ contrast: Number(e.target.value) })}
            style={{ accentColor: "#fff", width: "100%" }}
          />
        </div>
        <div>
          <Label>Width — chars</Label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="range"
              min={10}
              max={160}
              value={cols}
              aria-label="Width in characters"
              onChange={(e) => update({ cols: Number(e.target.value) })}
              style={{ accentColor: "#fff", flex: 1 }}
            />
            <input
              type="number"
              className="braille-num-input"
              min={10}
              max={300}
              value={cols}
              aria-label="Width in characters number input"
              onChange={(e) => {
                const v = Math.max(10, Math.min(300, Number(e.target.value)));
                update({ cols: v });
              }}
              style={{
                width: 60,
                background: "#0a0a0a",
                border: "2px solid #444",
                color: "#fff",
                fontFamily: "inherit",
                fontWeight: 700,
                fontSize: 13,
                padding: "6px 8px",
                textAlign: "center",
                letterSpacing: "0.1em",
              }}
            />
          </div>
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: 520, marginBottom: 32 }}>
        <Label>Brightness Mode</Label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className="braille-mode-btn"
              aria-pressed={mode === m}
              onClick={() => update({ mode: m })}
              style={{
                flex: "1 1 120px",
                padding: "8px 4px",
                background: mode === m ? "#fff" : "transparent",
                border: `2px solid ${mode === m ? "#fff" : "#444"}`,
                color: mode === m ? "#0a0a0a" : "#888",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                fontFamily: "inherit",
              }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {result ? (
        <div style={{ width: "100%", maxWidth: 700 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.25em",
                color: "#888",
                textTransform: "uppercase",
              }}
            >
              Output — {cols}w · {characterCount} chars
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="braille-copy-btn"
                onClick={handleCopy}
                style={{
                  background: copied ? "#fff" : "transparent",
                  border: `2px solid ${copied ? "#fff" : "#555"}`,
                  color: copied ? "#0a0a0a" : "#aaa",
                  padding: "6px 20px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  fontFamily: "inherit",
                }}
              >
                {copied ? "COPIED ✓" : "COPY"}
              </button>
              <button
                type="button"
                className="braille-download-btn"
                onClick={handleDownload}
                style={{
                  background: "transparent",
                  border: "2px solid #555",
                  color: "#aaa",
                  padding: "6px 20px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  fontFamily: "inherit",
                }}
              >
                DOWNLOAD
              </button>
            </div>
          </div>
          <pre
            style={{
              fontFamily: BRAILLE_FONT_STACK,
              fontSize: cols > 80 ? 8 : cols > 40 ? 10 : 12,
              lineHeight: 1,
              fontKerning: "none",
              fontVariantLigatures: "none",
              letterSpacing: 0,
              color: "#ccc",
              background: "#0d0d0d",
              border: "2px solid #333",
              padding: 20,
              overflowX: "auto",
              margin: 0,
              whiteSpace: "pre",
            }}
            aria-label="Braille art output"
          >
            {result}
          </pre>
        </div>
      ) : null}

      <div
        style={{
          marginTop: 48,
          fontSize: 11,
          fontWeight: 700,
          color: "#555",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
        }}
      >
        TIP — HIGH CONTRAST IMAGES WITH CLEAR SUBJECTS WORK BEST
      </div>
    </div>
  );
}
