"use strict";
var obsidian = require("obsidian");

var BACKUP_PATH = "_highlighter_backup.hl";

var DEFAULT_SETTINGS = {
  fontFamily: "'Plus Jakarta Sans', 'Nunito', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  colors: [
    { name: "Black", color: "#111111" },
    { name: "Yellow", color: "#ffe066" },
    { name: "Green", color: "#8ce99a" },
    { name: "Blue", color: "#74c0fc" },
    { name: "Pink", color: "#faa2c1" },
    { name: "Orange", color: "#ffc078" }
  ],
  hotkeys: {
    text: "t",
    select: "v",
    pen: "p",
    highlighter: "h",
    eraser: "e",
    bold: "b",
    italic: "i",
    underline: "u",
    sizeDown: "-",
    sizeUp: "=",
    align: "a",
    bullets: "8",
    numbers: "7"
  },
  textFormatting: {
    fontSize: 16,
    bold: false,
    italic: false,
    underline: false,
    align: "left"
  }
};

function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return p.replace(/\\/g, "/").trim();
}

function getDateStringFromMs(ms) {
  var d = ms ? new Date(ms) : new Date();
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function makeShortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function hashStringBase36(str) {
  var h1 = 2166136261;
  var h2 = 0x9e3779b9;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c + i;
    h2 = Math.imul(h2, 2246822519);
  }
  var part1 = (h1 >>> 0).toString(36);
  var part2 = (h2 >>> 0).toString(36);
  return (part1 + part2).replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
}

function sanitizeDeviceName(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

function quantize(v) {
  return Math.max(0, Math.min(10000, Math.round(v * 10000)));
}

function countTotalItems(mapObj) {
  if (!mapObj || typeof mapObj !== "object") return 0;
  var total = 0;
  for (var k in mapObj) {
    if (Array.isArray(mapObj[k])) total += mapObj[k].length;
  }
  return total;
}

function isItemDeleted(item, deletedMap) {
  if (!item || !item.id || !deletedMap) return false;
  var delAt = deletedMap[item.id];
  if (!delAt) return false;
  var explicitEdit = Math.max(item.updatedAt || 0, item.noteUpdatedAt || 0, item.colorUpdatedAt || 0);
  return !(explicitEdit > delAt);
}

function resolveMovedPath(rawPath, pathMoves) {
  var cur = normalizePath(rawPath);
  if (!pathMoves || !cur) return cur;
  var seen = new Set();
  while (pathMoves[cur] && pathMoves[cur].to && !seen.has(cur)) {
    seen.add(cur);
    cur = normalizePath(pathMoves[cur].to);
  }
  return cur;
}

function perpDistSq(pt, a, b) {
  var dx = b[0] - a[0];
  var dy = b[1] - a[1];
  var l2 = dx * dx + dy * dy;
  if (l2 === 0) return (pt[0] - a[0]) * (pt[0] - a[0]) + (pt[1] - a[1]) * (pt[1] - a[1]);
  var t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2;
  var px = a[0] + t * dx;
  var py = a[1] + t * dy;
  return (pt[0] - px) * (pt[0] - px) + (pt[1] - py) * (pt[1] - py);
}

function simplifyStrokePoints(points, eps) {
  if (!points || points.length <= 2) return points || [];
  var deduped = [points[0]];
  var minStepSq = 0.00018 * 0.00018;
  for (var d = 1; d < points.length - 1; d++) {
    var prev = deduped[deduped.length - 1];
    var dx = points[d][0] - prev[0];
    var dy = points[d][1] - prev[1];
    if (dx * dx + dy * dy >= minStepSq) deduped.push(points[d]);
  }
  deduped.push(points[points.length - 1]);
  if (deduped.length <= 2) return deduped;

  var epsSq = eps * eps;
  var keep = new Uint8Array(deduped.length);
  keep[0] = 1;
  keep[deduped.length - 1] = 1;

  var stack = [[0, deduped.length - 1]];
  while (stack.length > 0) {
    var pair = stack.pop();
    var start = pair[0];
    var end = pair[1];
    if (end - start <= 1) continue;
    var maxDist = 0;
    var maxIdx = -1;
    var a = deduped[start];
    var b = deduped[end];
    for (var i = start + 1; i < end; i++) {
      var dist = perpDistSq(deduped[i], a, b);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > epsSq && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  var out = [];
  for (var j = 0; j < deduped.length; j++) {
    if (keep[j]) out.push(deduped[j]);
  }
  return out.length >= 2 ? out : [deduped[0], deduped[deduped.length - 1]];
}

function encodeItem(item) {
  if (item.type === "text") {
    var tObj = {
      id: item.id,
      k: 2,
      p: item.page,
      x: quantize(item.x || 0),
      y: quantize(item.y || 0),
      t: item.text || "",
      c: item.color || "#111111"
    };
    if (item.fontSize && item.fontSize !== 16) tObj.fs = item.fontSize;
    var st = (item.bold ? 1 : 0) | (item.italic ? 2 : 0) | (item.underline ? 4 : 0);
    if (st) tObj.st = st;
    if (item.align === "center") tObj.al = "c";
    else if (item.align === "right") tObj.al = "r";
    if (item.updatedAt) tObj.u = item.updatedAt;
    return tObj;
  }

  if (item.type === "ink") {
    var pts = item.points || [];
    var flat = [];
    if (pts.length > 0) {
      var px = quantize(pts[0][0]);
      var py = quantize(pts[0][1]);
      flat.push(px, py);
      for (var i = 1; i < pts.length; i++) {
        var nx = quantize(pts[i][0]);
        var ny = quantize(pts[i][1]);
        var dx = nx - px;
        var dy = ny - py;
        if (dx !== 0 || dy !== 0 || i === pts.length - 1) {
          flat.push(dx, dy);
          px = nx;
          py = ny;
        }
      }
    }
    var iObj = {
      id: item.id,
      k: 1,
      p: item.page,
      c: item.color || "#111111",
      w: Math.round((item.width || 2.5) * 10) / 10,
      pts: flat
    };
    if (item.isHighlighter) iObj.h = 1;
    if (item.note) iObj.n = item.note;
    if (item.noteUpdatedAt) iObj.nu = item.noteUpdatedAt;
    if (item.colorUpdatedAt) iObj.cu = item.colorUpdatedAt;
    if (item.updatedAt) iObj.u = item.updatedAt;
    return iObj;
  }

  var flatRects = [];
  var rs = item.rects || [];
  for (var rIdx = 0; rIdx < rs.length; rIdx++) {
    flatRects.push(quantize(rs[rIdx].x), quantize(rs[rIdx].y), quantize(rs[rIdx].w), quantize(rs[rIdx].h));
  }
  var rObj = {
    id: item.id,
    k: 0,
    p: item.page,
    c: item.color || "#ffe066",
    r: flatRects
  };
  if (item.text) rObj.t = item.text;
  if (item.note) rObj.n = item.note;
  if (item.noteUpdatedAt) rObj.nu = item.noteUpdatedAt;
  if (item.colorUpdatedAt) rObj.cu = item.colorUpdatedAt;
  if (item.updatedAt) rObj.u = item.updatedAt;
  return rObj;
}

function decodeItem(raw, filePath) {
  if (!raw || !raw.id) return null;

  if (raw.k === 2) {
    var st = raw.st || 0;
    return {
      id: raw.id,
      type: "text",
      page: raw.p,
      x: (raw.x || 0) / 10000,
      y: (raw.y || 0) / 10000,
      text: raw.t || "",
      color: raw.c || "#111111",
      fontSize: raw.fs || 16,
      bold: !!(st & 1),
      italic: !!(st & 2),
      underline: !!(st & 4),
      align: raw.al === "c" ? "center" : raw.al === "r" ? "right" : "left",
      updatedAt: raw.u || 0
    };
  }

  if (raw.k === 1) {
    var flat = raw.pts || [];
    var points = [];
    if (flat.length >= 2) {
      var cx = flat[0];
      var cy = flat[1];
      points.push([cx / 10000, cy / 10000]);
      for (var i = 2; i + 1 < flat.length; i += 2) {
        cx += flat[i];
        cy += flat[i + 1];
        points.push([cx / 10000, cy / 10000]);
      }
      if (points.length === 1) points.push([points[0][0], points[0][1]]);
    }
    var iOut = {
      id: raw.id,
      type: "ink",
      isHighlighter: !!raw.h,
      page: raw.p,
      color: raw.c || "#111111",
      width: raw.w || 2.5,
      points: points,
      updatedAt: raw.u || 0
    };
    if (raw.n !== undefined) iOut.note = raw.n;
    else if (raw.nu) iOut.note = "";
    if (raw.nu) iOut.noteUpdatedAt = raw.nu;
    if (raw.cu) iOut.colorUpdatedAt = raw.cu;
    return iOut;
  }

  var fr = raw.r || [];
  var rects = [];
  for (var rIdx = 0; rIdx + 3 < fr.length; rIdx += 4) {
    rects.push({
      x: fr[rIdx] / 10000,
      y: fr[rIdx + 1] / 10000,
      w: fr[rIdx + 2] / 10000,
      h: fr[rIdx + 3] / 10000
    });
  }
  var rOut = {
    id: raw.id,
    filePath: filePath,
    page: raw.p,
    rects: rects,
    color: raw.c || "#ffe066",
    updatedAt: raw.u || 0
  };
  if (raw.t) rOut.text = raw.t;
  if (raw.n !== undefined) rOut.note = raw.n;
  else if (raw.nu) rOut.note = "";
  if (raw.nu) rOut.noteUpdatedAt = raw.nu;
  if (raw.cu) rOut.colorUpdatedAt = raw.cu;
  return rOut;
}

async function compressTextBytes(str) {
  var rawBytes = new TextEncoder().encode(str);
  if (typeof CompressionStream === "function") {
    try {
      var cs = new CompressionStream("gzip");
      var ab = await new Response(new Blob([rawBytes]).stream().pipeThrough(cs)).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {}
  }
  return rawBytes;
}

async function decompressBytesToText(buf) {
  var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream === "function") {
    var ds = new DecompressionStream("gzip");
    return await new Response(new Blob([u8]).stream().pipeThrough(ds)).text();
  }
  return new TextDecoder().decode(u8);
}

async function computePdfFingerprint(app, file) {
  try {
    if (!file || !(file instanceof obsidian.TFile)) return null;
    var size = file.stat.size;
    var buffer = await app.vault.readBinary(file);
    var sliceLen = Math.min(buffer.byteLength, 32768);
    var slice = buffer.slice(0, sliceLen);
    var hashBuffer = await crypto.subtle.digest("SHA-256", slice);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    var hashHex = hashArray.map(function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("").slice(0, 32);
    return { hash: hashHex, size: size, name: file.name };
  } catch (err) {
    console.warn("[Highlighter] Failed to fingerprint file:", err);
    return null;
  }
}

function getPageContentRect(pageEl) {
  if (!pageEl) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  var cw = pageEl.querySelector(":scope > .canvasWrapper");
  if (cw) {
    var cwRect = cw.getBoundingClientRect();
    if (cwRect.width > 0 && cwRect.height > 0) return cwRect;
  }
  var tl = pageEl.querySelector(":scope > .textLayer");
  if (tl) {
    var tlRect = tl.getBoundingClientRect();
    if (tlRect.width > 0 && tlRect.height > 0) return tlRect;
  }
  var pageRect = pageEl.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) return pageRect;
  var cs = window.getComputedStyle(pageEl);
  var bl = parseFloat(cs.borderLeftWidth) || 0;
  var br = parseFloat(cs.borderRightWidth) || 0;
  var bt = parseFloat(cs.borderTopWidth) || 0;
  var bb = parseFloat(cs.borderBottomWidth) || 0;
  var pl = parseFloat(cs.paddingLeft) || 0;
  var pr = parseFloat(cs.paddingRight) || 0;
  var pt = parseFloat(cs.paddingTop) || 0;
  var pb = parseFloat(cs.paddingBottom) || 0;
  var left = pageRect.left + bl + pl;
  var top = pageRect.top + bt + pt;
  var width = Math.max(0, pageRect.width - bl - br - pl - pr);
  var height = Math.max(0, pageRect.height - bt - bb - pt - pb);
  return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
}

function mergeNormalizedRects(rects) {
  if (!rects || rects.length <= 1) return rects ? rects.slice() : [];
  var sorted = rects.slice().sort(function (a, b) {
    if (Math.abs(a.y - b.y) > Math.min(a.h, b.h) * 0.45) return a.y - b.y;
    return a.x - b.x;
  });
  var merged = [];
  for (var i = 0; i < sorted.length; i++) {
    var cur = { x: sorted[i].x, y: sorted[i].y, w: sorted[i].w, h: sorted[i].h };
    if (merged.length === 0) {
      merged.push(cur);
      continue;
    }
    var prev = merged[merged.length - 1];
    var overlapTop = Math.max(prev.y, cur.y);
    var overlapBottom = Math.min(prev.y + prev.h, cur.y + cur.h);
    var overlapH = Math.max(0, overlapBottom - overlapTop);
    var minH = Math.min(prev.h, cur.h);
    if (minH > 0 && overlapH >= minH * 0.55 && cur.x <= prev.x + prev.w + 0.015) {
      var left = Math.min(prev.x, cur.x);
      var right = Math.max(prev.x + prev.w, cur.x + cur.w);
      var top = Math.min(prev.y, cur.y);
      var bottom = Math.max(prev.y + prev.h, cur.y + cur.h);
      prev.x = left;
      prev.y = top;
      prev.w = right - left;
      prev.h = bottom - top;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function getNoteAccentColor(hexColor) {
  if (!hexColor || typeof hexColor !== "string") return "#b08900";
  var clean = hexColor.trim();
  if (clean.startsWith("#")) {
    var hex = clean.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      var r = parseInt(hex.slice(0, 2), 16) / 255;
      var g = parseInt(hex.slice(2, 4), 16) / 255;
      var b = parseInt(hex.slice(4, 6), 16) / 255;
      var max = Math.max(r, g, b);
      var min = Math.min(r, g, b);
      var h = 0, s = 0, l = (max + min) / 2;
      if (max !== min) {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
      }
      var outL = l < 0.25 ? 0.22 : Math.max(0.24, Math.min(0.42, l * 0.56));
      var outS = s > 0.08 ? Math.min(0.95, s * 1.05) : s;
      return `hsl(${Math.round(h * 360)}, ${Math.round(outS * 100)}%, ${Math.round(outL * 100)}%)`;
    }
  }
  return hexColor;
}

function isHighlightItem(item) {
  if (!item || item.type === "text") return false;
  if (item.type === "ink") return !!item.isHighlighter;
  return !!(item.rects && item.rects.length > 0);
}

class HighlighterSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    var containerEl = this.containerEl;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Highlighter Settings" });

    containerEl.createEl("h3", { text: "Multi-Device Sync (Local to This Device)" });

    var autoName = this.plugin.getAutoDeviceName();
    var customName = this.plugin.loadCustomDeviceName();
    var pendingName = customName || "";

    var devSetting = new obsidian.Setting(containerEl)
      .setName("Device Name (local to this device)")
      .setDesc(
        `Sync file: ${this.plugin.deviceSyncPath} (saved only in localStorage). Leave blank to auto-detect (${autoName}). Renaming copies to the new filename and deletes the old file for Google Drive.`
      );

    devSetting.addText((text) => {
      text.setPlaceholder(autoName);
      text.setValue(customName || "");
      text.onChange((val) => {
        pendingName = val;
      });
      text.inputEl.addEventListener("keydown", async (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          await this.plugin.renameDeviceSyncName(pendingName);
          this.display();
        }
      });
    });

    devSetting.addButton((btn) => {
      btn.setButtonText("Apply").onClick(async () => {
        await this.plugin.renameDeviceSyncName(pendingName);
        this.display();
      });
    });

    new obsidian.Setting(containerEl)
      .setName("Reading device")
      .setDesc(
        "Removes the top-right highlight toolbar and disables editing on this device, while still showing all synced highlights/notes and jumping to synced reading positions. Creates 0 files in the vault root."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.readingDeviceMode).onChange((val) => {
          this.plugin.setReadingDeviceMode(val);
        });
      });

    containerEl.createEl("h3", { text: "Appearance & Text" });

    new obsidian.Setting(containerEl)
      .setName("Worksheet Text Font")
      .setDesc("Select a softer font or enter a custom font stack.")
      .addDropdown((drop) => {
        drop
          .addOption("'Plus Jakarta Sans', 'Nunito', 'Inter', sans-serif", "Soft Sans (Jakarta / Nunito)")
          .addOption("'Inter', -apple-system, BlinkMacSystemFont, sans-serif", "Inter Standard")
          .addOption("'Nunito', sans-serif", "Nunito Rounded")
          .addOption("Georgia, 'Times New Roman', serif", "Serif")
          .setValue(this.plugin.settings.fontFamily || DEFAULT_SETTINGS.fontFamily)
          .onChange(async (val) => {
            this.plugin.settings.fontFamily = val;
            await this.plugin.saveSettingsOnly();
            this.plugin.renderDataVersion++;
            this.plugin.scheduleAllPdfRender(true);
          });
      });

    containerEl.createEl("h3", { text: "Tool Hotkeys" });
    containerEl.createEl("p", {
      text: "Single keys switch tools when hovering over a PDF. Pressing the same tool key twice exits to the normal cursor.",
      cls: "setting-item-description"
    });

    var primaryTools = [
      { id: "text", name: "Text Tool" },
      { id: "select", name: "Select Tool" },
      { id: "highlighter", name: "Highlighter Tool" },
      { id: "pen", name: "Pen Tool" },
      { id: "eraser", name: "Eraser Tool" }
    ];

    primaryTools.forEach((t) => {
      new obsidian.Setting(containerEl)
        .setName(t.name)
        .addText((text) => {
          text.setValue(this.plugin.settings?.hotkeys?.[t.id] || "");
          text.inputEl.style.width = "50px";
          text.inputEl.style.textAlign = "center";
          text.inputEl.style.textTransform = "uppercase";
          text.inputEl.addEventListener("keydown", async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.key.length === 1) {
              var char = evt.key.toLowerCase();
              text.setValue(char);
              if (!this.plugin.settings.hotkeys) this.plugin.settings.hotkeys = {};
              this.plugin.settings.hotkeys[t.id] = char;
              await this.plugin.saveSettingsOnly();
              document.querySelectorAll(".drive-pdf-toolbar-group").forEach((el) => el.remove());
              this.plugin.injectIntoAllLeaves();
            }
          });
        });
    });

    containerEl.createEl("h3", { text: "Text Formatting Hotkeys" });
    containerEl.createEl("p", {
      text: "Customizable hotkeys for text effects. Inside text mode, '-' and '=' change font size.",
      cls: "setting-item-description"
    });

    var formatHotkeys = [
      { id: "bold", name: "Bold Toggle (Ctrl/Cmd+Key)" },
      { id: "italic", name: "Italic Toggle (Ctrl/Cmd+Key)" },
      { id: "underline", name: "Underline Toggle (Ctrl/Cmd+Key)" },
      { id: "sizeDown", name: "Font Size Smaller" },
      { id: "sizeUp", name: "Font Size Larger" },
      { id: "align", name: "Cycle Alignment (Left/Center/Right)" },
      { id: "bullets", name: "Toggle Bullet List" },
      { id: "numbers", name: "Toggle Numbered List" }
    ];

    formatHotkeys.forEach((f) => {
      new obsidian.Setting(containerEl)
        .setName(f.name)
        .addText((text) => {
          text.setValue(this.plugin.settings?.hotkeys?.[f.id] || "");
          text.inputEl.style.width = "50px";
          text.inputEl.style.textAlign = "center";
          text.inputEl.addEventListener("keydown", async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.key.length === 1) {
              var val = evt.key.toLowerCase();
              text.setValue(val);
              if (!this.plugin.settings.hotkeys) this.plugin.settings.hotkeys = {};
              this.plugin.settings.hotkeys[f.id] = val;
              await this.plugin.saveSettingsOnly();
            }
          });
        });
    });

    containerEl.createEl("h3", { text: "Palette Colors" });
    containerEl.createEl("p", {
      text: "Colors shown in the toolbar. Keys 1-9 switch colors.",
      cls: "setting-item-description"
    });

    (this.plugin.settings.colors || []).forEach((c, idx) => {
      var keyHint = idx < 9 ? ` [Key: ${idx + 1}]` : "";
      new obsidian.Setting(containerEl)
        .setName(`Color ${idx + 1}${keyHint}`)
        .addText((t) =>
          t.setValue(c?.name || `Color ${idx + 1}`).onChange(async (val) => {
            c.name = val;
            await this.plugin.saveSettingsOnly();
            this.plugin.updateAllToolbarColors();
          })
        )
        .addColorPicker((cp) =>
          cp.setValue(c?.color || "#ffe066").onChange(async (val) => {
            c.color = val;
            await this.plugin.saveSettingsOnly();
            this.plugin.updateAllToolbarColors();
            if (this.plugin.activeColor === c?.color) this.plugin.activeColor = c.color;
          })
        )
        .addExtraButton((b) =>
          b.setIcon("trash").onClick(async () => {
            this.plugin.settings.colors.splice(idx, 1);
            if (this.plugin.activeColor === c?.color) {
              this.plugin.setColor(this.plugin.settings.colors[0]?.color || "#111111");
            }
            await this.plugin.saveSettingsOnly();
            this.plugin.updateAllToolbarColors();
            this.display();
          })
        );
    });

    new obsidian.Setting(containerEl).addButton((b) =>
      b.setButtonText("Add Color").onClick(async () => {
        this.plugin.settings.colors.push({ name: "Custom", color: "#ffd43b" });
        await this.plugin.saveSettingsOnly();
        this.plugin.updateAllToolbarColors();
        this.display();
      })
    );
  }
}

class HighlighterPlugin extends obsidian.Plugin {
  async onload() {
    try {
      await this.loadSettings();

      this.deviceId = this.getOrCreateDeviceId();
      this.deviceName = this.resolveDeviceName();
      this.deviceSyncPath = `_highlighter_${this.deviceName}.hl`;
      this.readingDeviceMode = this.loadLocalReadingDeviceMode();

      this.pdfHighlights = {};
      this.fileSignatures = {};
      this.deletedIds = {};
      this.pathMoves = {};
      this.viewStates = {};

      this.activeTool = "none";
      this.activeColor = this.settings.colors[0]?.color || "#111111";

      this.isDrawing = false;
      this.isErasing = false;
      this.isBarrelErasing = false;
      this.hasErased = false;
      this.erasedSnapshotTaken = false;
      this.isDraggingTextBox = false;

      this.activePointerId = null;
      this.activePointerType = null;
      this.currentStroke = null;
      this.activeStrokeEl = null;
      this.activeSvgViewHeight = 1000;
      this.activePageEl = null;
      this.activeEditingBox = null;
      this.activeTextBoxId = null;
      this.pendingHighlighterTap = null;
      this.suppressHighlighterReopenId = null;
      this.pendingReadTap = null;

      this.syncInitialized = false;
      this.hasExplicitUserDeletion = false;
      this.localDirty = false;
      this.localViewStateDirty = false;
      this.needsPeerMirrorRefresh = false;
      this.ownFileExistsOnDisk = false;
      this.isWritingSyncFile = false;
      this.writeQueued = false;
      this._pendingMirrorRefresh = false;
      this.externalSyncTimer = null;
      this.viewStateSaveTimer = null;
      this.seenSyncFileMeta = new Map();
      this.peerDeviceActivity = new Map();
      this.readableConflictFirstSeen = new Map();
      this.unreadableConflictFirstSeen = new Map();
      this.maxSeenRemoteTs = 0;
      this.lastOwnWriteAt = 0;
      this.lastPruneCheckAt = 0;
      this.preDeleteBackupHoldUntil = 0;
      this.lastCommittedItemCount = 0;
      this.lastCommittedPayloadObj = null;
      this.lastSavedDigest = "";
      this.todayBackupDoneDate = "";

      this.renderDataVersion = 1;
      this.suppressMutationDepth = 0;

      this.history = new Map();
      this.sessionErasedIds = new Set();
      this.viewBindings = new Map();
      this.reconciledFiles = new Set();
      this.hoveredPdfLeaf = null;

      this.hoveredHighlight = null;
      this.hoverOpenTimer = null;
      this.hoverCloseTimer = null;
      this.addNotePillEl = null;
      this.notePopover = null;
      this.pendingHighlightClick = null;
      this.textSaveTimer = null;
      this.renderRafId = null;

      this.addSettingTab(new HighlighterSettingTab(this.app, this));

      this.onKeyDownCapture = (e) => this.handleKeyDown(e);
      window.addEventListener("keydown", this.onKeyDownCapture, true);

      this.registerDomEvent(document, "pointermove", (e) => this.trackHoveredPdfLeaf(e), { passive: true });
      this.registerDomEvent(document, "pointerover", (e) => this.trackHoveredPdfLeaf(e), { passive: true });
      this.registerDomEvent(document, "pointerdown", (e) => this.onPointerDown(e), { passive: false });
      this.registerDomEvent(document, "pointermove", (e) => this.onPointerMove(e), { passive: false });
      this.registerDomEvent(document, "pointerup", (e) => this.onPointerUp(e));
      this.registerDomEvent(document, "pointercancel", (e) => this.onPointerCancel(e));
      this.registerDomEvent(document, "contextmenu", (e) => this.onContextMenu(e));
      this.registerDomEvent(document, "selectionchange", () => this.handleLiveSelectionPreview());

      this.registerDomEvent(window, "wheel", (e) => {
        if (e.ctrlKey || e.metaKey) this.scheduleAllPdfRender(false);
      }, { passive: true });

      this.registerDomEvent(window, "resize", () => {
        this.scheduleAllPdfRender(false);
        this.repositionNotePopover();
      }, { passive: true });

      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          if (!this.readingDeviceMode) {
            if (this.captureAllOpenViewStates()) this.localViewStateDirty = true;
            window.clearTimeout(this.textSaveTimer);
            window.clearTimeout(this.viewStateSaveTimer);
            this.flushSyncWriteNow({ allowMirrorRefresh: true });
          }
        } else if (document.visibilityState === "visible" && this.syncInitialized) {
          this.checkExternalSyncUpdates();
        }
      });

      this.registerDomEvent(window, "pagehide", () => {
        if (!this.readingDeviceMode) {
          if (this.captureAllOpenViewStates()) this.localViewStateDirty = true;
          window.clearTimeout(this.textSaveTimer);
          window.clearTimeout(this.viewStateSaveTimer);
          this.flushSyncWriteNow({ allowMirrorRefresh: true });
        }
      });

      this.registerDomEvent(window, "focus", () => {
        this.onWorkspaceUpdated();
        if (this.syncInitialized) this.checkExternalSyncUpdates();
      });

      this.registerInterval(
        window.setInterval(() => {
          if (this.syncInitialized && document.visibilityState === "visible") {
            this.checkExternalSyncUpdates();
            if (
              !this.readingDeviceMode &&
              this.needsPeerMirrorRefresh &&
              this.ownFileExistsOnDisk &&
              Date.now() - this.lastOwnWriteAt >= 1800000
            ) {
              this.flushSyncWriteNow({ allowMirrorRefresh: true });
            }
          }
        }, 15000)
      );

      this.registerEvent(
        this.app.vault.on("rename", async (file, oldPath) => {
          await this.handleVaultRename(file, oldPath);
        })
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (this.isWatchedSyncFile(file)) this.scheduleExternalSyncCheck(150);
        })
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (this.isWatchedSyncFile(file)) this.scheduleExternalSyncCheck(150);
        })
      );

      this.registerEvent(this.app.workspace.on("layout-change", () => this.onWorkspaceUpdated()));
      this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
        if (!this.readingDeviceMode && this.captureAllOpenViewStates()) {
          this.localViewStateDirty = true;
          this.scheduleViewStateSave(true);
        }
        this.onWorkspaceUpdated();
        if (this.syncInitialized) this.checkExternalSyncUpdates();
      }));
      this.registerEvent(this.app.workspace.on("file-open", () => this.onWorkspaceUpdated()));

      this.app.workspace.onLayoutReady(async () => {
        this.onWorkspaceUpdated();
        await this.initSyncEngine();
        this.syncInitialized = true;
        this.reconciledFiles.clear();
        await this.onWorkspaceUpdated();
        for (var binding of this.viewBindings.values()) {
          this.restorePdfViewStateIfNeeded(binding, false);
        }
        this.runVaultReconciliation();
        this.renderDataVersion++;
        this.scheduleAllPdfRender(true);
      });
    } catch (err) {
      console.error("[Highlighter] Init failed:", err);
      new obsidian.Notice("Highlighter initialization error: " + err.message);
    }
  }

  onunload() {
    try {
      window.removeEventListener("keydown", this.onKeyDownCapture, true);
      window.clearTimeout(this.hoverOpenTimer);
      window.clearTimeout(this.hoverCloseTimer);
      window.clearTimeout(this.textSaveTimer);
      window.clearTimeout(this.viewStateSaveTimer);
      window.clearTimeout(this.externalSyncTimer);
      if (this.renderRafId) window.cancelAnimationFrame(this.renderRafId);

      if (this.activeEditingBox) this.activeEditingBox.blur();
      if (this.notePopover && this.notePopover.mode === "edit") {
        this.commitAndCloseNotePopover();
      } else {
        this.closeNotePopover(false);
      }
      this.hideAddNotePill();

      if (!this.readingDeviceMode) {
        if (this.captureAllOpenViewStates()) this.localViewStateDirty = true;
        this.flushSyncWriteNow({ allowMirrorRefresh: true });
      }

      for (var binding of this.viewBindings.values()) {
        this.destroyViewBinding(binding);
      }
      this.viewBindings.clear();

      document.querySelectorAll(".drive-pdf-toolbar-group").forEach((el) => el.remove());
      document.querySelectorAll(".drive-pdf-page-overlay").forEach((el) => el.remove());
      document.querySelectorAll(".drive-annotation-layer").forEach((el) => el.remove());
      document.querySelectorAll(".drive-text-annotation-layer").forEach((el) => el.remove());
      document.querySelectorAll(".drive-note-popover, .drive-note-add-pill").forEach((el) => el.remove());
    } catch (err) {
      console.error("[Highlighter] Error on unload:", err);
    }
  }

  // --- LOCALSTORAGE HELPERS & HUMAN-READABLE DEVICE IDENTITY ---
  readLocalStorageValue(key) {
    try {
      if (typeof this.app.loadLocalStorage === "function") return this.app.loadLocalStorage(key);
      if (window.localStorage) return window.localStorage.getItem(key);
    } catch (e) {}
    return null;
  }

  writeLocalStorageValue(key, val) {
    try {
      if (val === null || val === undefined || val === "") {
        if (typeof this.app.saveLocalStorage === "function") this.app.saveLocalStorage(key, null);
        if (window.localStorage) window.localStorage.removeItem(key);
        return;
      }
      if (typeof this.app.saveLocalStorage === "function") this.app.saveLocalStorage(key, val);
      else if (window.localStorage) window.localStorage.setItem(key, val);
    } catch (e) {}
  }

  getOrCreateDeviceId() {
    var key = "highlighter-device-id";
    var id = this.readLocalStorageValue(key);
    if (!id || typeof id !== "string" || !/^[a-zA-Z0-9_-]{6,48}$/.test(id)) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.writeLocalStorageValue(key, id);
    }
    return id;
  }

  loadCustomDeviceName() {
    var raw = this.readLocalStorageValue("highlighter-device-name");
    var clean = sanitizeDeviceName(raw || "");
    return clean === "backup" ? "" : clean;
  }

  saveCustomDeviceName(name) {
    var clean = sanitizeDeviceName(name || "");
    this.writeLocalStorageValue("highlighter-device-name", clean && clean !== "backup" ? clean : null);
  }

  loadLocalReadingDeviceMode() {
    var raw = this.readLocalStorageValue("highlighter-reading-device");
    return raw === true || raw === "true" || raw === "1";
  }

  setReadingDeviceMode(enabled) {
    this.readingDeviceMode = !!enabled;
    this.writeLocalStorageValue("highlighter-reading-device", this.readingDeviceMode ? "true" : "false");

    if (this.readingDeviceMode) {
      this.setTool("none");
      this.localDirty = false;
      this.localViewStateDirty = false;
      window.clearTimeout(this.textSaveTimer);
      window.clearTimeout(this.viewStateSaveTimer);
      this.textSaveTimer = null;
      this.viewStateSaveTimer = null;
      document.querySelectorAll(".drive-pdf-toolbar-group").forEach((el) => el.remove());
    } else {
      this.injectIntoAllLeaves();
    }
    this.updateCursorMode();
  }

  getAutoDeviceName() {
    var shortHash = hashStringBase36(this.deviceId).slice(0, 4);
    var base = "";
    try {
      if (!obsidian.Platform?.isMobile && typeof require === "function") {
        var osMod = require("os");
        if (osMod && typeof osMod.hostname === "function") {
          var rawHost = osMod.hostname();
          if (rawHost && typeof rawHost === "string") {
            rawHost = rawHost.replace(/\.(local|lan|home|internal)$/i, "");
            base = sanitizeDeviceName(rawHost).slice(0, 24).replace(/-+$/g, "");
          }
        }
      }
    } catch (e) {}

    if (!base || base === "localhost" || base === "backup") {
      var ua = typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
      if (obsidian.Platform?.isIosApp || (!obsidian.Platform && /iphone|ipad|ipod/i.test(ua))) base = "ios";
      else if (obsidian.Platform?.isAndroidApp || (!obsidian.Platform && /android/i.test(ua))) base = "android";
      else if (obsidian.Platform?.isMobile) base = "mobile";
      else base = "desktop";
    }
    return `${base}-${shortHash}`;
  }

  resolveDeviceName() {
    var custom = this.loadCustomDeviceName();
    return custom || this.getAutoDeviceName();
  }

  async removeFileWithRetry(path) {
    var adapter = this.app.vault.adapter;
    for (var i = 0; i < 3; i++) {
      try {
        if (!(await adapter.exists(path))) return true;
        await adapter.remove(path);
        return true;
      } catch (err) {
        await new Promise((res) => window.setTimeout(res, 120 * (i + 1)));
      }
    }
    return false;
  }

  async renameDeviceSyncName(rawInput) {
    var trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
    var cleanCustom = sanitizeDeviceName(trimmed);
    if (trimmed && !cleanCustom) {
      new obsidian.Notice("[Highlighter] Device name must contain letters or numbers; using auto-detected name.");
    }
    if (cleanCustom === "backup") {
      new obsidian.Notice('[Highlighter] "backup" is reserved for _highlighter_backup.hl. Choose another device name.');
      return;
    }

    var targetName = cleanCustom || this.getAutoDeviceName();
    var newPath = `_highlighter_${targetName}.hl`;
    var oldPath = this.deviceSyncPath;

    if (newPath === oldPath) {
      this.saveCustomDeviceName(cleanCustom);
      return;
    }

    while (this.isWritingSyncFile) {
      await new Promise((res) => window.setTimeout(res, 50));
    }

    this.isWritingSyncFile = true;
    try {
      var adapter = this.app.vault.adapter;

      if (await adapter.exists(newPath)) {
        var existingTarget = await this.readParsedFile(newPath);
        if (existingTarget && existingTarget.d && existingTarget.d !== this.deviceId) {
          new obsidian.Notice(`[Highlighter] "${targetName}" is already in use by another device. Choose a different name.`);
          return;
        }
      }

      this.saveCustomDeviceName(cleanCustom);
      this.deviceName = targetName;
      this.deviceSyncPath = newPath;

      if (this.readingDeviceMode) {
        this.ownFileExistsOnDisk = false;
        new obsidian.Notice(`[Highlighter] Reading device name set to "${targetName}" (no file created).`);
        return;
      }

      var oldExists = await adapter.exists(oldPath);
      if (oldExists || this.ownFileExistsOnDisk) {
        if (oldExists) {
          var oldData = await this.readParsedFile(oldPath);
          if (oldData) this.mergeStatePayloadIntoMemory(oldData);
        }

        // Copy to new file first, verify it exists on disk, then delete the old file for Google Drive
        var payloadObj = this.buildEncodedStatePayload();
        var bytes = await compressTextBytes(JSON.stringify(payloadObj));
        await this.writeBytesDirectSafe(newPath, bytes);

        if (!(await adapter.exists(newPath))) {
          throw new Error("Copied sync file verification failed: " + newPath);
        }

        this.ownFileExistsOnDisk = true;
        this.lastOwnWriteAt = payloadObj.u;
        this.lastSavedDigest = JSON.stringify({ hl: payloadObj.hl, del: payloadObj.del, mv: payloadObj.mv, vs: payloadObj.vs });
        this.peerDeviceActivity.set(this.deviceId, { path: newPath, u: payloadObj.u });

        if (oldExists && oldPath !== newPath) {
          await this.removeFileWithRetry(oldPath);
          this.seenSyncFileMeta.delete(oldPath);
        }
        new obsidian.Notice(`[Highlighter] Copied to ${newPath} and deleted old file.`);
      } else {
        this.ownFileExistsOnDisk = false;
        new obsidian.Notice(`[Highlighter] Device name set to "${targetName}"`);
      }
    } catch (err) {
      console.error("[Highlighter] Device rename error:", err);
      new obsidian.Notice("[Highlighter] Failed to copy/rename device file: " + err.message);
    } finally {
      this.isWritingSyncFile = false;
    }
  }

  // --- SPLIT-PANE HOVER TRACKING & LEAF HELPERS ---
  trackHoveredPdfLeaf(e) {
    var target = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!target) return;
    var container = target.closest(".pdf-container, .pdf-viewer-container, .pdf-viewer");
    if (container) {
      var leaf = this.getLeafForElement(container);
      if (leaf) {
        this.hoveredPdfLeaf = leaf;
        return;
      }
    }
    if (!target.closest(".drive-note-popover, .drive-note-add-pill")) {
      this.hoveredPdfLeaf = null;
    }
  }

  getLeafForElement(el) {
    if (!el) return null;
    var found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      if (!leaf.isDeferred && leaf.view && leaf.view.containerEl && leaf.view.containerEl.contains(el)) {
        found = leaf;
      }
    });
    return found;
  }

  getLeafFile(leaf) {
    if (!leaf || leaf.isDeferred) return null;
    if (leaf.view && leaf.view.file instanceof obsidian.TFile) return leaf.view.file;
    var stateFile = leaf.getViewState?.()?.state?.file;
    if (stateFile && typeof stateFile === "string") {
      var af = this.app.vault.getAbstractFileByPath(stateFile);
      if (af instanceof obsidian.TFile) return af;
    }
    return null;
  }

  getActivePdfFileFallback() {
    var leaf = this.hoveredPdfLeaf || this.app.workspace.activeLeaf;
    var file = this.getLeafFile(leaf);
    if (file && file.extension === "pdf") return file;
    var activeFile = this.app.workspace.getActiveFile();
    return activeFile && activeFile.extension === "pdf" ? activeFile : null;
  }

  // --- PDF VIEW STATE (PAGE, SCROLL, ZOOM/FIT-WIDTH, DOUBLE SPREAD) ---
  getPdfViewerObjects(binding) {
    var view = binding?.view;
    if (!view) return null;
    var v = binding.resolvedViewerChild || view.viewer;
    if (!v) return null;
    var child = v.child || v;
    var wrapper = child?.pdfViewer || child;
    var pv = wrapper?.pdfViewer || wrapper;
    if (!pv || typeof pv !== "object") return null;
    if (pv.currentPageNumber === undefined && !pv.pagesCount && !pv._pages) return null;
    return { child: child, wrapper: wrapper, pv: pv };
  }

  restorePdfViewStateIfNeeded(binding, forceLiveJump) {
    if (!binding || !binding.leaf || binding.leaf.isDeferred || !this.syncInitialized) return;
    var file = this.getLeafFile(binding.leaf);
    if (!file || file.extension !== "pdf") return;

    var normPath = normalizePath(file.path);
    var saved = this.viewStates[normPath];
    var savedTs = saved?.u || 0;

    if (!forceLiveJump && binding.restoredFilePath === normPath) return;
    if (forceLiveJump && binding.restoredFilePath === normPath && savedTs <= (binding.appliedViewStateU || 0)) return;

    var objs = this.getPdfViewerObjects(binding);
    if (!objs) return;
    var pv = objs.pv;
    var wrapper = objs.wrapper;
    var eb = binding.eventBusTarget;
    if (!pv.pdfDocument && (!pv.pagesCount || pv.pagesCount <= 0)) return;

    binding.restoredFilePath = normPath;
    if (!saved) return;

    binding.appliedViewStateU = savedTs;
    var leafState = binding.leaf.getViewState?.()?.state;
    var hasExplicitSubpath = !forceLiveJump && !!(leafState?.subpath && /page=|selection=|annotation=/i.test(leafState.subpath));
    binding.isRestoringViewState = true;

    if (binding.restoreTimer) window.clearTimeout(binding.restoreTimer);

    try {
      if (typeof saved.rot === "number" && pv.pagesRotation !== saved.rot) pv.pagesRotation = saved.rot;

      if (typeof saved.sm === "number" && pv.scrollMode !== saved.sm) {
        if (typeof wrapper?.setScrollMode === "function") wrapper.setScrollMode(saved.sm);
        else {
          pv.scrollMode = saved.sm;
          if (eb && typeof eb.dispatch === "function") eb.dispatch("scrollmodechanged", { source: pv, mode: saved.sm });
        }
      }

      if (typeof saved.sp === "number" && pv.spreadMode !== saved.sp) {
        if (typeof wrapper?.setSpreadMode === "function") wrapper.setSpreadMode(saved.sp);
        else {
          pv.spreadMode = saved.sp;
          if (eb && typeof eb.dispatch === "function") eb.dispatch("spreadmodechanged", { source: pv, mode: saved.sp });
        }
      }

      if (saved.sc && pv.currentScaleValue !== saved.sc) {
        if (typeof wrapper?.setScale === "function") wrapper.setScale(saved.sc);
        else pv.currentScaleValue = saved.sc;
      }

      var applyPosition = () => {
        if (!this.viewBindings.has(binding.view)) return;
        var curObjs = this.getPdfViewerObjects(binding);
        if (!curObjs) return;
        var cpv = curObjs.pv;
        if (!hasExplicitSubpath && saved.p && saved.p >= 1) {
          var maxP = cpv.pagesCount || saved.p;
          var targetP = Math.max(1, Math.min(maxP, saved.p));
          if (typeof cpv.scrollPageIntoView === "function" && (saved.t !== undefined || saved.l !== undefined)) {
            cpv.scrollPageIntoView({
              pageNumber: targetP,
              destArray: [null, { name: "XYZ" }, saved.l !== undefined ? saved.l : null, saved.t !== undefined ? saved.t : null, null],
              ignoreDestinationZoom: true
            });
          } else {
            cpv.currentPageNumber = targetP;
          }
        }
      };

      applyPosition();
      window.requestAnimationFrame(() => applyPosition());
      binding.restoreTimer = window.setTimeout(() => {
        binding.restoreTimer = null;
        applyPosition();
        binding.isRestoringViewState = false;
        this.scheduleLeafRender(binding, true);
      }, 140);
    } catch (e) {
      binding.isRestoringViewState = false;
    }
  }

  applySyncedViewStatesToOpenBindings(changedViewPaths) {
    if (!changedViewPaths || changedViewPaths.size === 0) return;
    for (var binding of this.viewBindings.values()) {
      var file = this.getLeafFile(binding.leaf);
      if (!file || file.extension !== "pdf") continue;
      var normPath = normalizePath(file.path);
      if (changedViewPaths.has(normPath)) {
        this.restorePdfViewStateIfNeeded(binding, true);
      }
    }
  }

  captureBindingViewState(binding) {
    if (this.readingDeviceMode) return false;
    if (!binding || !binding.leaf || binding.leaf.isDeferred || binding.isRestoringViewState || !this.syncInitialized) {
      return false;
    }
    var file = this.getLeafFile(binding.leaf);
    if (!file || file.extension !== "pdf") return false;
    var normPath = normalizePath(file.path);
    if (binding.restoredFilePath !== normPath) return false;

    var objs = this.getPdfViewerObjects(binding);
    if (!objs) return false;
    var pv = objs.pv;
    if (!pv.pdfDocument && (!pv.pagesCount || pv.pagesCount <= 0)) return false;

    var loc = pv._location;
    var page = (loc && typeof loc.pageNumber === "number" && loc.pageNumber > 0) ? loc.pageNumber : (pv.currentPageNumber || 1);

    var sc = pv.currentScaleValue;
    if (typeof sc !== "string" || !sc) {
      sc = typeof pv.currentScale === "number" ? String(Math.round(pv.currentScale * 1000) / 1000) : "page-width";
    } else if (/^\d+(\.\d+)?$/.test(sc)) {
      sc = String(Math.round(parseFloat(sc) * 1000) / 1000);
    }

    var next = { p: page, sc: sc };
    if (loc && typeof loc.top === "number" && isFinite(loc.top)) next.t = Math.round(loc.top);
    if (loc && typeof loc.left === "number" && isFinite(loc.left) && Math.round(loc.left) !== 0) next.l = Math.round(loc.left);
    if (typeof pv.spreadMode === "number" && pv.spreadMode !== 0) next.sp = pv.spreadMode;
    if (typeof pv.scrollMode === "number" && pv.scrollMode !== 0) next.sm = pv.scrollMode;
    if (typeof pv.pagesRotation === "number" && pv.pagesRotation !== 0) next.rot = pv.pagesRotation;

    var prev = this.viewStates[normPath];
    if (
      prev &&
      prev.p === next.p &&
      prev.sc === next.sc &&
      (prev.sp || 0) === (next.sp || 0) &&
      (prev.sm || 0) === (next.sm || 0) &&
      (prev.rot || 0) === (next.rot || 0) &&
      Math.abs((prev.t || 0) - (next.t || 0)) <= 4 &&
      Math.abs((prev.l || 0) - (next.l || 0)) <= 4
    ) {
      return false;
    }

    next.u = this.nowTs();
    this.viewStates[normPath] = next;
    binding.appliedViewStateU = next.u;
    return true;
  }

  captureAllOpenViewStates() {
    if (this.readingDeviceMode) return false;
    var anyChanged = false;
    for (var binding of this.viewBindings.values()) {
      if (this.captureBindingViewState(binding)) anyChanged = true;
    }
    return anyChanged;
  }

  scheduleViewStateSave(immediate) {
    if (this.readingDeviceMode) return;
    window.clearTimeout(this.viewStateSaveTimer);
    if (immediate) {
      this.viewStateSaveTimer = null;
      if (this.localViewStateDirty || this.localDirty) this.flushSyncWriteNow();
      return;
    }
    this.viewStateSaveTimer = window.setTimeout(() => {
      this.viewStateSaveTimer = null;
      if (this.localViewStateDirty || this.localDirty) this.flushSyncWriteNow();
    }, 10000);
  }

  // --- VIEW LIFECYCLE & PDF.JS EVENT BUS BINDING ---
  async onWorkspaceUpdated() {
    this.cleanupDeadViewBindings();
    var pdfLeaves = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!leaf.isDeferred && leaf.view && leaf.view.getViewType?.() === "pdf") {
        pdfLeaves.push(leaf);
      }
    });

    for (var i = 0; i < pdfLeaves.length; i++) {
      var leaf = pdfLeaves[i];
      this.bindPdfView(leaf);
      this.injectIntoNativeToolbar(leaf);
      var file = this.getLeafFile(leaf);
      if (file && file.extension === "pdf" && this.syncInitialized) {
        await this.ensureFileHighlightsSafe(file);
      }
    }

    this.updateCursorMode();
    this.scheduleAllPdfRender(false);
  }

  bindPdfView(leaf) {
    if (!leaf || leaf.isDeferred || !leaf.view) return;
    var view = leaf.view;
    var containerEl = view.containerEl;
    if (!containerEl) return;

    var existing = this.viewBindings.get(view);
    if (existing) {
      existing.leaf = leaf;
      var curFile = this.getLeafFile(leaf);
      var nextPath = curFile ? normalizePath(curFile.path) : "";
      if (nextPath && existing.filePath !== nextPath) {
        existing.filePath = nextPath;
        existing.restoredFilePath = "";
        existing.appliedViewStateU = 0;
        this.restorePdfViewStateIfNeeded(existing, false);
        this.scheduleLeafRender(existing, true);
      }
      if (!existing.eventBusBound) this.tryBindPdfJsEventBus(existing);
      this.observePagesInContainer(existing);
      return;
    }

    var file = this.getLeafFile(leaf);
    var binding = {
      leaf: leaf,
      view: view,
      containerEl: containerEl,
      filePath: file ? normalizePath(file.path) : "",
      restoredFilePath: "",
      appliedViewStateU: 0,
      isRestoringViewState: false,
      restoreTimer: null,
      resolvedViewerChild: null,
      observedPages: new WeakSet(),
      eventBusBound: false,
      eventBusTarget: null,
      eventBusCleanup: [],
      retryTimers: [],
      renderTimer: null,
      mutationObs: null,
      pageResizeObs: null,
      intersectionObs: null,
      scrollTarget: null,
      scrollHandler: null
    };

    var isOurNode = (node) => {
      if (!(node instanceof Element)) return false;
      return (
        node.classList.contains("drive-pdf-page-overlay") ||
        node.classList.contains("drive-annotation-layer") ||
        node.classList.contains("drive-text-annotation-layer") ||
        node.classList.contains("drive-pdf-toolbar-group") ||
        node.classList.contains("drive-note-popover") ||
        node.classList.contains("drive-note-add-pill")
      );
    };

    binding.mutationObs = new MutationObserver((mutations) => {
      if (this.suppressMutationDepth > 0 || this.isDrawing || this.isErasing) return;
      var needsRender = false;
      var needsToolbar = false;

      for (var mIdx = 0; mIdx < mutations.length; mIdx++) {
        var m = mutations[mIdx];
        var target = m.target instanceof Element ? m.target : m.target?.parentElement;
        if (
          target &&
          target.closest(
            ".drive-pdf-page-overlay, .drive-annotation-layer, .drive-text-annotation-layer, .drive-pdf-toolbar-group, .drive-note-popover, .drive-note-add-pill"
          )
        ) {
          continue;
        }
        if (target && target.closest(".pdf-toolbar, .pdf-toolbar-right, .toolbar")) {
          if (m.addedNodes && Array.from(m.addedNodes).every(isOurNode)) continue;
          needsToolbar = true;
        }
        var addedAllOurs =
          m.addedNodes &&
          m.addedNodes.length > 0 &&
          (!m.removedNodes || m.removedNodes.length === 0) &&
          Array.from(m.addedNodes).every(isOurNode);
        if (addedAllOurs) continue;
        needsRender = true;
      }

      if (needsToolbar) this.injectIntoNativeToolbar(binding.leaf);
      if (needsRender) {
        this.observePagesInContainer(binding);
        this.attachScrollListener(binding);
        this.scheduleLeafRender(binding, false);
      }
    });

    binding.mutationObs.observe(containerEl, { childList: true, subtree: true });

    binding.pageResizeObs = new ResizeObserver((entries) => {
      var anyResized = false;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var target = entry.target;
        var pageEl = target.classList.contains("page") ? target : target.closest(".page[data-page-number]");
        if (pageEl) {
          this.syncPageOverlayGeometry(pageEl);
          anyResized = true;
        } else if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          anyResized = true;
        }
      }
      if (anyResized) {
        this.repositionNotePopover();
        this.scheduleLeafRender(binding, false);
      }
    });

    binding.pageResizeObs.observe(containerEl);

    binding.intersectionObs = new IntersectionObserver(
      (entries) => {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            this.scheduleLeafRender(binding, false);
            break;
          }
        }
      },
      { root: containerEl, rootMargin: "900px 0px" }
    );

    this.viewBindings.set(view, binding);
    this.observePagesInContainer(binding);
    this.attachScrollListener(binding);
    this.tryBindPdfJsEventBus(binding);

    [80, 250, 700, 1500, 3000].forEach((ms) => {
      var t = window.setTimeout(() => {
        if (!this.viewBindings.has(view)) return;
        this.injectIntoNativeToolbar(binding.leaf);
        if (!binding.eventBusBound) this.tryBindPdfJsEventBus(binding);
        this.restorePdfViewStateIfNeeded(binding, false);
        this.observePagesInContainer(binding);
        this.scheduleLeafRender(binding, false);
      }, ms);
      binding.retryTimers.push(t);
    });
  }

  observePagesInContainer(binding) {
    if (!binding || !binding.containerEl) return;
    var pages = binding.containerEl.querySelectorAll(".page[data-page-number]");
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (!binding.observedPages.has(p)) {
        binding.observedPages.add(p);
        binding.pageResizeObs.observe(p);
        binding.intersectionObs.observe(p);
      }
      var cw = p.querySelector(":scope > .canvasWrapper");
      if (cw && !binding.observedPages.has(cw)) {
        binding.observedPages.add(cw);
        binding.pageResizeObs.observe(cw);
      }
    }
  }

  attachScrollListener(binding) {
    if (!binding || !binding.containerEl) return;
    var scroller =
      binding.containerEl.querySelector(".pdf-viewer-container") ||
      binding.containerEl.querySelector(".pdf-container");
    if (!scroller || binding.scrollTarget === scroller) return;
    if (binding.scrollTarget && binding.scrollHandler) {
      binding.scrollTarget.removeEventListener("scroll", binding.scrollHandler);
    }

    var ticking = false;
    binding.scrollTarget = scroller;
    binding.scrollHandler = () => {
      if (this.notePopover && this.notePopover.mode === "preview") this.closeNotePopover(false);
      else if (this.notePopover && this.notePopover.mode === "edit") this.repositionNotePopover();
      this.hideAddNotePill();

      if (!this.readingDeviceMode && this.captureBindingViewState(binding)) {
        this.localViewStateDirty = true;
        this.scheduleViewStateSave(false);
      }

      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(() => {
          ticking = false;
          if (this.viewBindings.has(binding.view)) {
            this.renderLeafViews(binding, false);
            if (this.notePopover && this.notePopover.mode === "edit") this.repositionNotePopover();
          }
        });
      }
    };
    scroller.addEventListener("scroll", binding.scrollHandler, { passive: true });
  }

  tryBindPdfJsEventBus(binding) {
    if (!binding || binding.eventBusBound || !binding.view) return;
    try {
      var viewerObj = binding.view.viewer;
      if (!viewerObj) return;
      if (typeof viewerObj.then === "function") {
        viewerObj.then((resolved) => {
          binding.resolvedViewerChild = resolved;
          if (this.viewBindings.has(binding.view) && !binding.eventBusBound) {
            this.attachEventBusFromChild(binding, resolved);
          }
          this.restorePdfViewStateIfNeeded(binding, false);
        }).catch(() => {});
      }
      this.attachEventBusFromChild(binding, viewerObj);
    } catch (e) {}
  }

  attachEventBusFromChild(binding, viewerObj) {
    if (!viewerObj || binding.eventBusBound) return;
    var child = viewerObj.child || viewerObj;
    var pv = child?.pdfViewer || child;
    var eb = pv?.eventBus || pv?.pdfViewer?.eventBus || child?.eventBus;
    if (!eb || typeof eb.on !== "function") return;

    binding.eventBusBound = true;
    binding.eventBusTarget = eb;

    var onPageRendered = (evt) => {
      if (!this.viewBindings.has(binding.view)) return;
      this.observePagesInContainer(binding);
      var pageNum = evt?.pageNumber || evt?.source?.id;
      if (pageNum) {
        var pageEl = binding.containerEl.querySelector(`.page[data-page-number="${pageNum}"]`);
        if (pageEl) {
          this.renderSinglePageByElement(binding, pageEl, true);
          return;
        }
      }
      this.scheduleLeafRender(binding, true);
    };

    var onPagesLoaded = () => {
      if (!this.viewBindings.has(binding.view)) return;
      this.observePagesInContainer(binding);
      this.attachScrollListener(binding);
      this.restorePdfViewStateIfNeeded(binding, false);
      this.scheduleLeafRender(binding, true);
    };

    var onScaleEvent = () => {
      if (!this.viewBindings.has(binding.view)) return;
      var pages = binding.containerEl.querySelectorAll(".page[data-page-number]");
      for (var i = 0; i < pages.length; i++) this.syncPageOverlayGeometry(pages[i]);
      this.repositionNotePopover();
      if (!this.readingDeviceMode && this.captureBindingViewState(binding)) {
        this.localViewStateDirty = true;
        this.scheduleViewStateSave(false);
      }
      this.scheduleLeafRender(binding, false);
    };

    var onModeChanged = () => {
      if (!this.viewBindings.has(binding.view)) return;
      if (!this.readingDeviceMode && this.captureBindingViewState(binding)) {
        this.localViewStateDirty = true;
        this.scheduleViewStateSave(true);
      }
      this.scheduleLeafRender(binding, false);
    };

    var onPageChanging = () => {
      if (!this.viewBindings.has(binding.view)) return;
      if (!this.readingDeviceMode && this.captureBindingViewState(binding)) {
        this.localViewStateDirty = true;
        this.scheduleViewStateSave(false);
      }
    };

    var onUpdateViewArea = () => {
      if (!this.viewBindings.has(binding.view)) return;
      this.observePagesInContainer(binding);
      if (!this.readingDeviceMode && this.captureBindingViewState(binding)) {
        this.localViewStateDirty = true;
        this.scheduleViewStateSave(false);
      }
      this.scheduleLeafRender(binding, false);
    };

    var events = [
      ["pagerendered", onPageRendered],
      ["textlayerrendered", onPageRendered],
      ["pagesloaded", onPagesLoaded],
      ["pagesinit", onPagesLoaded],
      ["scalechanging", onScaleEvent],
      ["scalechange", onScaleEvent],
      ["spreadmodechanged", onModeChanged],
      ["scrollmodechanged", onModeChanged],
      ["rotationchanging", onModeChanged],
      ["pagechanging", onPageChanging],
      ["updateviewarea", onUpdateViewArea]
    ];

    events.forEach(([name, fn]) => {
      eb.on(name, fn);
      binding.eventBusCleanup.push(() => {
        if (typeof eb.off === "function") eb.off(name, fn);
      });
    });

    this.restorePdfViewStateIfNeeded(binding, false);
    this.scheduleLeafRender(binding, true);
  }

  destroyViewBinding(binding) {
    if (!binding) return;
    if (!this.readingDeviceMode && this.captureBindingViewState(binding)) {
      this.localViewStateDirty = true;
      this.scheduleViewStateSave(true);
    }
    if (binding.mutationObs) binding.mutationObs.disconnect();
    if (binding.pageResizeObs) binding.pageResizeObs.disconnect();
    if (binding.intersectionObs) binding.intersectionObs.disconnect();
    if (binding.scrollTarget && binding.scrollHandler) {
      binding.scrollTarget.removeEventListener("scroll", binding.scrollHandler);
    }
    if (binding.renderTimer) window.clearTimeout(binding.renderTimer);
    if (binding.restoreTimer) window.clearTimeout(binding.restoreTimer);
    binding.retryTimers.forEach((t) => window.clearTimeout(t));
    binding.eventBusCleanup.forEach((fn) => {
      try { fn(); } catch (e) {}
    });
    binding.retryTimers = [];
    binding.eventBusCleanup = [];
  }

  cleanupDeadViewBindings() {
    var activeViews = new Set();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!leaf.isDeferred && leaf.view && leaf.view.getViewType?.() === "pdf") {
        activeViews.add(leaf.view);
      }
    });
    for (var [view, binding] of this.viewBindings.entries()) {
      if (!activeViews.has(view) || !binding.containerEl || !binding.containerEl.isConnected) {
        this.destroyViewBinding(binding);
        this.viewBindings.delete(view);
      }
    }
  }

  // --- MOVE-SAFE HIGHLIGHT & VIEW STATE RECONCILIATION ---
  ensureSignatureForPath(normPath) {
    if (this.readingDeviceMode || !normPath || this.fileSignatures[normPath]) return;
    var af = this.app.vault.getAbstractFileByPath(normPath);
    if (af instanceof obsidian.TFile) {
      computePdfFingerprint(this.app, af).then((sig) => {
        if (sig && !this.fileSignatures[normPath]) {
          this.fileSignatures[normPath] = sig;
          if (!this.readingDeviceMode && this.pdfHighlights[normPath]?.length) {
            this.localDirty = true;
            this.saveAnnotationsNow();
          }
        }
      });
    }
  }

  migrateSinglePdfPath(normOld, normNew, now) {
    var moved = false;
    if (this.pdfHighlights[normOld]) {
      var movedList = this.pdfHighlights[normOld];
      var targetList = this.pdfHighlights[normNew] || [];
      var seen = new Set(targetList.map((i) => i.id));
      movedList.forEach((item) => {
        if (item && item.id && !seen.has(item.id)) {
          item.filePath = normNew;
          targetList.push(item);
        }
      });
      this.pdfHighlights[normNew] = targetList;
      delete this.pdfHighlights[normOld];
      moved = true;
    }
    if (this.viewStates[normOld]) {
      if (!this.viewStates[normNew] || (this.viewStates[normOld].u || 0) > (this.viewStates[normNew].u || 0)) {
        this.viewStates[normNew] = this.viewStates[normOld];
      }
      delete this.viewStates[normOld];
      moved = true;
    }
    if (this.fileSignatures[normOld]) {
      this.fileSignatures[normNew] = this.fileSignatures[normOld];
      delete this.fileSignatures[normOld];
    }
    if (moved) {
      this.pathMoves[normOld] = { to: normNew, at: now };
    }
    return moved;
  }

  async handleVaultRename(file, oldPath) {
    var normOld = normalizePath(oldPath);
    var normNew = normalizePath(file.path);
    var changed = false;
    var now = this.nowTs();

    if (file instanceof obsidian.TFile) {
      if (this.migrateSinglePdfPath(normOld, normNew, now)) changed = true;
    } else if (file instanceof obsidian.TFolder) {
      var oldPrefix = normOld + "/";
      var newPrefix = normNew + "/";
      var keys = new Set(Object.keys(this.pdfHighlights).concat(Object.keys(this.viewStates)));
      keys.forEach((k) => {
        if (k.startsWith(oldPrefix)) {
          var updatedKey = newPrefix + k.slice(oldPrefix.length);
          if (this.migrateSinglePdfPath(k, updatedKey, now)) changed = true;
        }
      });
    }

    if (changed) {
      this.renderDataVersion++;
      this.scheduleAllPdfRender(true);
      if (!this.readingDeviceMode) {
        this.localDirty = true;
        await this.saveAnnotationsNow();
      }
    }
  }

  hasOrphanHighlightEntries() {
    for (var p in this.pdfHighlights) {
      var list = this.pdfHighlights[p];
      if (Array.isArray(list) && list.length > 0 && !this.app.vault.getAbstractFileByPath(p)) {
        return true;
      }
    }
    return false;
  }

  async ensureFileHighlightsSafe(file) {
    if (!file || file.extension !== "pdf") return;
    var normPath = normalizePath(file.path);
    if (this.reconciledFiles.has(normPath)) return;
    this.reconciledFiles.add(normPath);

    var existing = this.pdfHighlights[normPath];
    if (existing && existing.length > 0) {
      if (!this.readingDeviceMode && !this.fileSignatures[normPath]) {
        var sig = await computePdfFingerprint(this.app, file);
        if (sig) this.fileSignatures[normPath] = sig;
      }
      return;
    }

    if (!this.hasOrphanHighlightEntries()) return;
    var currentSig = await computePdfFingerprint(this.app, file);
    if (!currentSig) return;

    var matchedOldPath = null;
    for (var p in this.pdfHighlights) {
      if (p === normPath) continue;
      var listP = this.pdfHighlights[p];
      if (!listP || !listP.length) continue;
      var oldSig = this.fileSignatures[p];
      if (oldSig && oldSig.hash === currentSig.hash && oldSig.size === currentSig.size) {
        if (!this.app.vault.getAbstractFileByPath(p)) {
          matchedOldPath = p;
          break;
        }
      }
    }

    if (!matchedOldPath) {
      for (var orphanPath in this.pdfHighlights) {
        if (orphanPath === normPath) continue;
        var listO = this.pdfHighlights[orphanPath];
        if (!listO || !listO.length) continue;
        var orphanSig = this.fileSignatures[orphanPath];
        var orphanBase = orphanPath.split("/").pop();
        var matches = orphanSig
          ? orphanSig.name === file.name && orphanSig.size === file.stat.size
          : orphanBase === file.name;
        if (matches && !this.app.vault.getAbstractFileByPath(orphanPath)) {
          matchedOldPath = orphanPath;
          break;
        }
      }
    }

    if (matchedOldPath) {
      this.migrateSinglePdfPath(matchedOldPath, normPath, this.nowTs());
      this.fileSignatures[normPath] = currentSig;
      this.renderDataVersion++;
      this.scheduleAllPdfRender(true);
      if (!this.readingDeviceMode) {
        this.localDirty = true;
        new obsidian.Notice(`[Highlighter] Restored annotations for moved file: ${file.name}`);
        await this.saveAnnotationsNow();
      }
    }
  }

  async runVaultReconciliation() {
    try {
      var allFiles = this.app.vault.getFiles().filter((f) => f.extension === "pdf");
      var fileMapByName = new Map();
      allFiles.forEach((f) => {
        var list = fileMapByName.get(f.name) || [];
        list.push(f);
        fileMapByName.set(f.name, list);
      });

      var changed = false;
      var now = this.nowTs();
      for (var storedPath in this.pdfHighlights) {
        var storedItems = this.pdfHighlights[storedPath];
        if (!storedItems || !storedItems.length) continue;
        if (!this.app.vault.getAbstractFileByPath(storedPath)) {
          var baseName = storedPath.split("/").pop();
          var candidates = fileMapByName.get(baseName);
          if (candidates && candidates.length === 1) {
            var newNorm = normalizePath(candidates[0].path);
            if (!this.pdfHighlights[newNorm] || !this.pdfHighlights[newNorm].length) {
              if (this.migrateSinglePdfPath(storedPath, newNorm, now)) changed = true;
            }
          }
        }
      }

      if (changed) {
        this.renderDataVersion++;
        this.scheduleAllPdfRender(true);
        if (!this.readingDeviceMode) {
          this.localDirty = true;
          await this.saveAnnotationsNow();
        }
      }
    } catch (e) {
      console.warn("[Highlighter] Vault reconciliation check:", e);
    }
  }

  // --- SINGLE-WRITER PER-DEVICE SYNC ENGINE + SHARED BACKUP ---
  nowTs() {
    var now = Date.now();
    if (this.maxSeenRemoteTs >= now && this.maxSeenRemoteTs - now <= 86400000) {
      return this.maxSeenRemoteTs + 1;
    }
    return now;
  }

  bumpMaxSeenTs(ts) {
    if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return;
    if (ts > this.maxSeenRemoteTs && ts <= Date.now() + 86400000) {
      this.maxSeenRemoteTs = ts;
    }
  }

  classifySyncFile(rootPath) {
    if (!rootPath || rootPath.includes("/")) return null;
    if (/\.hl\.(tmp|prev)$/i.test(rootPath)) return "temp";
    if (!/_highlighter_.*\.hl$/i.test(rootPath)) return null;
    if (rootPath === BACKUP_PATH) return "backup";
    if (rootPath === this.deviceSyncPath) return "own";
    if (/^_highlighter_[a-z0-9][a-z0-9_-]*\.hl$/i.test(rootPath)) return "peer";
    return "conflict";
  }

  isWatchedSyncFile(file) {
    if (!file || !(file instanceof obsidian.TFile)) return false;
    var p = normalizePath(file.path);
    var kind = this.classifySyncFile(p);
    if (!kind || kind === "temp") return false;
    if (kind === "own" && this.isWritingSyncFile) return false;
    return true;
  }

  scheduleExternalSyncCheck(delayMs) {
    window.clearTimeout(this.externalSyncTimer);
    this.externalSyncTimer = window.setTimeout(() => {
      this.checkExternalSyncUpdates();
    }, delayMs || 150);
  }

  buildEncodedStatePayload(stampTs) {
    var encodedHl = {};
    for (var p in this.pdfHighlights) {
      var list = this.pdfHighlights[p];
      if (!Array.isArray(list) || list.length === 0) continue;
      var outArr = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id) outArr.push(encodeItem(list[i]));
      }
      if (outArr.length > 0) encodedHl[p] = outArr;
    }

    return {
      v: 6,
      d: this.deviceId,
      dn: this.deviceName,
      u: stampTs || this.nowTs(),
      del: this.deletedIds,
      mv: this.pathMoves,
      sig: this.fileSignatures,
      vs: this.viewStates,
      hl: encodedHl
    };
  }

  async writeBytesDirectSafe(targetPath, u8) {
    if (!u8 || u8.length < 2) throw new Error("Refusing to write empty payload");

    var verifyText = await decompressBytesToText(u8);
    var verifyObj = JSON.parse(verifyText);
    if (!verifyObj || verifyObj.v !== 6) throw new Error("In-memory payload verification failed");

    var adapter = this.app.vault.adapter;
    var buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    var lastErr = null;

    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        await adapter.writeBinary(targetPath, buf);
        try {
          var st = await adapter.stat(targetPath);
          if (st) {
            if (st.size !== u8.length) throw new Error("Disk write size mismatch");
            this.seenSyncFileMeta.set(targetPath, `${st.mtime}:${st.size}`);
          }
        } catch (statErr) {
          if (statErr?.message === "Disk write size mismatch") throw statErr;
        }
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((res) => window.setTimeout(res, 90 * (attempt + 1)));
      }
    }
    throw lastErr || new Error("Failed writing " + targetPath);
  }

  async readParsedFile(path) {
    try {
      var adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      var rawBuf = await adapter.readBinary(path);
      if (!rawBuf || rawBuf.byteLength < 2) return null;
      var text = await decompressBytesToText(rawBuf);
      if (!text || text.trim().length < 2) return null;
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.v !== 6) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  mergeStatePayloadIntoMemory(remote) {
    if (!remote || typeof remote !== "object" || remote.v !== 6) {
      return { changed: false, changedViewPaths: new Set() };
    }
    var changed = false;
    var changedViewPaths = new Set();
    this.bumpMaxSeenTs(remote.u);

    var remoteDeleted = remote.del || {};
    for (var delId in remoteDeleted) {
      var rDelAt = Number(remoteDeleted[delId]) || 1;
      this.bumpMaxSeenTs(rDelAt);
      var lDelAt = Number(this.deletedIds[delId]) || 0;
      if (rDelAt > lDelAt) {
        this.deletedIds[delId] = rDelAt;
        changed = true;
      }
    }

    var remoteMoves = remote.mv || {};
    for (var oldP in remoteMoves) {
      var rm = remoteMoves[oldP];
      if (!rm || !rm.to) continue;
      var normOld = normalizePath(oldP);
      var rMvAt = rm.at || 0;
      this.bumpMaxSeenTs(rMvAt);
      var lm = this.pathMoves[normOld];
      if (!lm || rMvAt > (lm.at || 0)) {
        this.pathMoves[normOld] = { to: normalizePath(rm.to), at: rMvAt };
        changed = true;
      }
    }

    if (remote.sig) {
      for (var sigPath in remote.sig) {
        var normSigPath = resolveMovedPath(sigPath, this.pathMoves);
        if (!this.fileSignatures[normSigPath]) this.fileSignatures[normSigPath] = remote.sig[sigPath];
      }
    }

    if (remote.vs) {
      for (var rawVsPath in remote.vs) {
        var rVs = remote.vs[rawVsPath];
        if (!rVs || typeof rVs !== "object") continue;
        this.bumpMaxSeenTs(rVs.u);
        var normVsPath = normalizePath(rawVsPath);
        if (this.pathMoves[normVsPath] && !this.app.vault.getAbstractFileByPath(normVsPath)) {
          normVsPath = resolveMovedPath(normVsPath, this.pathMoves);
        }
        var lVs = this.viewStates[normVsPath];
        if (!lVs || (rVs.u || 0) > (lVs.u || 0)) {
          this.viewStates[normVsPath] = Object.assign({}, rVs);
          changed = true;
          changedViewPaths.add(normVsPath);
        }
      }
    }

    for (var curPath in this.pdfHighlights) {
      var curItems = this.pdfHighlights[curPath];
      if (!Array.isArray(curItems)) {
        delete this.pdfHighlights[curPath];
        continue;
      }
      var keptLocal = [];
      for (var lIdx = 0; lIdx < curItems.length; lIdx++) {
        var lItem = curItems[lIdx];
        if (!lItem || !lItem.id) continue;
        if (isItemDeleted(lItem, this.deletedIds)) changed = true;
        else keptLocal.push(lItem);
      }
      if (keptLocal.length !== curItems.length) this.pdfHighlights[curPath] = keptLocal;

      var resolvedLocalPath = resolveMovedPath(curPath, this.pathMoves);
      if (resolvedLocalPath !== curPath && !this.app.vault.getAbstractFileByPath(curPath)) {
        var destList = this.pdfHighlights[resolvedLocalPath] || [];
        var destIds = new Set(destList.map((d) => d.id));
        for (var kIdx = 0; kIdx < keptLocal.length; kIdx++) {
          var mvItem = keptLocal[kIdx];
          if (!destIds.has(mvItem.id)) {
            mvItem.filePath = resolvedLocalPath;
            destList.push(mvItem);
            destIds.add(mvItem.id);
          }
          changed = true;
        }
        this.pdfHighlights[resolvedLocalPath] = destList;
        delete this.pdfHighlights[curPath];
      }
    }

    var remoteHl = remote.hl || {};
    for (var rawPath in remoteHl) {
      var normRemotePath = normalizePath(rawPath);
      var moveEntry = this.pathMoves[normRemotePath];
      var targetPath = normRemotePath;
      if (moveEntry && !this.app.vault.getAbstractFileByPath(normRemotePath)) {
        targetPath = resolveMovedPath(normRemotePath, this.pathMoves);
      }

      var diskItems = remoteHl[rawPath];
      if (!Array.isArray(diskItems)) continue;

      var localItems = this.pdfHighlights[targetPath] || [];
      var localMap = new Map(localItems.map((i) => [i.id, i]));

      for (var dIdx = 0; dIdx < diskItems.length; dIdx++) {
        var dItem = decodeItem(diskItems[dIdx], targetPath);
        if (!dItem) continue;

        this.bumpMaxSeenTs(dItem.updatedAt);
        this.bumpMaxSeenTs(dItem.noteUpdatedAt);
        this.bumpMaxSeenTs(dItem.colorUpdatedAt);

        if (isItemDeleted(dItem, this.deletedIds)) continue;

        if (this.deletedIds[dItem.id]) {
          delete this.deletedIds[dItem.id];
          changed = true;
        }

        if (!localMap.has(dItem.id)) {
          localItems.push(dItem);
          localMap.set(dItem.id, dItem);
          changed = true;
        } else {
          var existing = localMap.get(dItem.id);
          if (dItem.type === "text") {
            if ((dItem.updatedAt || 0) > (existing.updatedAt || 0)) {
              Object.assign(existing, dItem);
              changed = true;
            }
          } else {
            if ((dItem.noteUpdatedAt || 0) > (existing.noteUpdatedAt || 0)) {
              existing.note = dItem.note;
              existing.noteUpdatedAt = dItem.noteUpdatedAt;
              changed = true;
            }
            if ((dItem.colorUpdatedAt || 0) > (existing.colorUpdatedAt || 0)) {
              existing.color = dItem.color;
              existing.colorUpdatedAt = dItem.colorUpdatedAt;
              changed = true;
            }
          }
        }
      }

      if (localItems.length > 0) this.pdfHighlights[targetPath] = localItems;
    }

    return { changed: changed, changedViewPaths: changedViewPaths };
  }

  async ensureNonCollidingOwnPathOnInit() {
    var adapter = this.app.vault.adapter;
    this.deviceName = this.resolveDeviceName();
    this.deviceSyncPath = `_highlighter_${this.deviceName}.hl`;

    if (this.readingDeviceMode) return;

    if (await adapter.exists(this.deviceSyncPath)) {
      var existing = await this.readParsedFile(this.deviceSyncPath);
      if (existing && existing.d && existing.d !== this.deviceId) {
        var shortHash = hashStringBase36(this.deviceId).slice(0, 4);
        var base = sanitizeDeviceName(this.deviceName).slice(0, 26).replace(/-+$/g, "") || "device";
        var disambiguated = `${base}-${shortHash}`;
        if (disambiguated === this.deviceName || disambiguated === "backup") {
          disambiguated = `${base.slice(0, 22)}-${hashStringBase36(this.deviceId + ":2").slice(0, 4)}`;
        }
        this.deviceName = disambiguated;
        this.deviceSyncPath = `_highlighter_${this.deviceName}.hl`;
        this.saveCustomDeviceName(disambiguated);
        new obsidian.Notice(`[Highlighter] Device name collided with another device; using "${disambiguated}".`);
      }
    }
  }

  async initSyncEngine() {
    try {
      var adapter = this.app.vault.adapter;
      await this.ensureNonCollidingOwnPathOnInit();
      this.ownFileExistsOnDisk = !this.readingDeviceMode && (await adapter.exists(this.deviceSyncPath));

      if (!this.readingDeviceMode) {
        var listing = await adapter.list("");
        var rootFiles = listing?.files || [];
        for (var tIdx = 0; tIdx < rootFiles.length; tIdx++) {
          var tp = normalizePath(rootFiles[tIdx]);
          if (tp === `${this.deviceSyncPath}.tmp` || tp === `${this.deviceSyncPath}.prev`) {
            var rec = await this.readParsedFile(tp);
            if (rec && this.mergeStatePayloadIntoMemory(rec).changed) this.localDirty = true;
            try { await adapter.remove(tp); } catch (e) {}
          }
        }
      }

      var scanRes = await this.readAllRootSyncFiles(true);

      // Fallback recovery from _highlighter_backup.hl if live files are empty
      if (countTotalItems(this.pdfHighlights) === 0 && Object.keys(this.viewStates).length === 0) {
        var bak = await this.readParsedFile(BACKUP_PATH);
        if (bak && (countTotalItems(bak.hl) > 0 || Object.keys(bak.vs || {}).length > 0)) {
          this.mergeStatePayloadIntoMemory(bak);
          if (!this.readingDeviceMode) this.localDirty = true;
          new obsidian.Notice("[Highlighter] Recovered annotations from backup.");
        }
      }

      var totalNow = countTotalItems(this.pdfHighlights);
      var payloadObj = this.buildEncodedStatePayload();
      this.lastCommittedItemCount = totalNow;
      this.lastCommittedPayloadObj = payloadObj;

      if (this.readingDeviceMode) {
        this.localDirty = false;
        this.localViewStateDirty = false;
        return;
      }

      if (this.ownFileExistsOnDisk) {
        var ownData = await this.readParsedFile(this.deviceSyncPath);
        if (ownData) {
          this.lastOwnWriteAt = ownData.u || 0;
          this.lastSavedDigest = JSON.stringify({ hl: ownData.hl, del: ownData.del, mv: ownData.mv, vs: ownData.vs });
          var curDigest = JSON.stringify({ hl: payloadObj.hl, del: payloadObj.del, mv: payloadObj.mv, vs: payloadObj.vs });
          if (curDigest !== this.lastSavedDigest) this.needsPeerMirrorRefresh = true;
        }
      }

      if (scanRes.ownConflicts.length > 0) this.localDirty = true;

      if (this.localDirty) {
        await this.flushSyncWriteNow({ allowMirrorRefresh: true });
        await this.cleanupSettledConflicts(scanRes.ownConflicts);
      } else if (this.ownFileExistsOnDisk && (totalNow > 0 || Object.keys(this.viewStates).length > 0)) {
        await this.ensureBackupUpdated(payloadObj, false);
        if (scanRes.backupConflicts.length > 0 && this.isBackupLeader()) {
          await this.cleanupSettledConflicts(scanRes.backupConflicts);
        }
      }
    } catch (e) {
      console.warn("[Highlighter] Sync init notice:", e);
    }
  }

  async cleanupSettledConflicts(paths) {
    if (this.readingDeviceMode || !paths || !paths.length || !this.ownFileExistsOnDisk) return;
    var adapter = this.app.vault.adapter;
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      try {
        await adapter.remove(p);
        this.seenSyncFileMeta.delete(p);
        this.readableConflictFirstSeen.delete(p);
      } catch (e) {}
    }
  }

  isOwnConflictFile(fPath, parsedData) {
    if (parsedData && parsedData.d === this.deviceId) return true;
    var prefix = `_highlighter_${this.deviceName}`;
    return fPath.startsWith(prefix + " ") || fPath.startsWith(prefix + "(") || fPath.startsWith(prefix + ".");
  }

  isBackupConflictFile(fPath) {
    return /_highlighter_backup/i.test(fPath) && fPath !== BACKUP_PATH;
  }

  async readAllRootSyncFiles(includeOwn) {
    var adapter = this.app.vault.adapter;
    var changed = false;
    var changedViewPaths = new Set();
    var ownConflicts = [];
    var backupConflicts = [];
    var now = Date.now();

    try {
      var listing = await adapter.list("");
      var files = listing?.files || [];

      for (var i = 0; i < files.length; i++) {
        var fPath = normalizePath(files[i]);
        var kind = this.classifySyncFile(fPath);
        if (!kind || kind === "temp" || kind === "backup") continue;
        if (!includeOwn && kind === "own") continue;

        var isConflict = kind === "conflict";
        var stat = await adapter.stat(fPath);
        var metaKey = stat ? `${stat.mtime}:${stat.size}` : "";

        if (!isConflict && metaKey && this.seenSyncFileMeta.get(fPath) === metaKey) {
          continue;
        }

        var data = await this.readParsedFile(fPath);
        if (metaKey && !isConflict) this.seenSyncFileMeta.set(fPath, metaKey);

        if (!data) {
          if (isConflict && !this.readingDeviceMode) {
            if (!this.unreadableConflictFirstSeen.has(fPath)) {
              this.unreadableConflictFirstSeen.set(fPath, now);
            } else if (now - this.unreadableConflictFirstSeen.get(fPath) > 60000 && this.isOwnConflictFile(fPath, null)) {
              try {
                await adapter.remove(fPath);
                this.unreadableConflictFirstSeen.delete(fPath);
              } catch (e) {}
            }
          }
          continue;
        }

        if ((kind === "peer" || kind === "own") && data.d) {
          var actTs = data.u || (stat ? stat.mtime : 0);
          var prevAct = this.peerDeviceActivity.get(data.d);
          if (!prevAct || actTs >= prevAct.u) {
            this.peerDeviceActivity.set(data.d, { path: fPath, u: actTs });
          }
        }

        if (isConflict) {
          this.unreadableConflictFirstSeen.delete(fPath);
          if (!this.readableConflictFirstSeen.has(fPath)) {
            this.readableConflictFirstSeen.set(fPath, now);
          }
          var resC = this.mergeStatePayloadIntoMemory(data);
          if (resC.changed) changed = true;
          resC.changedViewPaths.forEach((vp) => changedViewPaths.add(vp));

          if (!this.readingDeviceMode) {
            var settledLocally = now - this.readableConflictFirstSeen.get(fPath) >= 5000;
            var settledMtime = !stat || now - stat.mtime >= 5000;
            if (settledLocally && settledMtime) {
              if (this.isOwnConflictFile(fPath, data)) ownConflicts.push(fPath);
              else if (this.isBackupConflictFile(fPath)) backupConflicts.push(fPath);
            }
          }
          continue;
        }

        var res = this.mergeStatePayloadIntoMemory(data);
        if (res.changed) changed = true;
        res.changedViewPaths.forEach((vp) => changedViewPaths.add(vp));
      }
    } catch (e) {
      console.warn("[Highlighter] Error reading sync files:", e);
    }

    return {
      changed: changed,
      changedViewPaths: changedViewPaths,
      ownConflicts: ownConflicts,
      backupConflicts: backupConflicts
    };
  }

  async checkExternalSyncUpdates() {
    if (!this.syncInitialized || this.isWritingSyncFile) return;
    var res = await this.readAllRootSyncFiles(false);
    if (res.changed) {
      this.renderDataVersion++;
      this.scheduleAllPdfRender(true);
      if (this.readingDeviceMode) {
        this.applySyncedViewStatesToOpenBindings(res.changedViewPaths);
      } else {
        this.needsPeerMirrorRefresh = true;
      }
    }

    if (this.readingDeviceMode) return;

    if (res.ownConflicts.length > 0) this.localDirty = true;

    if (this.localDirty || this.localViewStateDirty) {
      await this.flushSyncWriteNow();
      if (res.ownConflicts.length > 0) await this.cleanupSettledConflicts(res.ownConflicts);
    } else if (this.ownFileExistsOnDisk) {
      var bakData = await this.readParsedFile(BACKUP_PATH);
      if (bakData) {
        if (res.backupConflicts.length > 0 && this.isBackupLeader()) {
          await this.cleanupSettledConflicts(res.backupConflicts);
        }
        await this.pruneRetiredPeerFiles(bakData);
      }
    }
  }

  isBackupLeader() {
    if (this.readingDeviceMode || !this.ownFileExistsOnDisk) return false;
    var now = Date.now();
    var activeWindowMs = 48 * 3600 * 1000;
    var activeIds = [this.deviceId];
    for (var [devId, info] of this.peerDeviceActivity.entries()) {
      if (devId && now - (info.u || 0) <= activeWindowMs && activeIds.indexOf(devId) === -1) {
        activeIds.push(devId);
      }
    }
    activeIds.sort();
    return activeIds[0] === this.deviceId;
  }

  hasUnaccountedBackupData(existingBackup, candidatePayload) {
    if (!existingBackup || !existingBackup.hl) return false;

    var candMap = new Map();
    var cHl = candidatePayload.hl || {};
    for (var cp in cHl) {
      var cArr = cHl[cp];
      if (!Array.isArray(cArr)) continue;
      for (var i = 0; i < cArr.length; i++) {
        if (cArr[i] && cArr[i].id) candMap.set(cArr[i].id, cArr[i]);
      }
    }

    var candDel = candidatePayload.del || {};
    var eHl = existingBackup.hl || {};
    for (var ep in eHl) {
      var eArr = eHl[ep];
      if (!Array.isArray(eArr)) continue;
      for (var j = 0; j < eArr.length; j++) {
        var raw = eArr[j];
        if (!raw || !raw.id) continue;
        var cRaw = candMap.get(raw.id);
        if (cRaw) {
          if ((raw.u || 0) > (cRaw.u || 0) || (raw.nu || 0) > (cRaw.nu || 0) || (raw.cu || 0) > (cRaw.cu || 0)) {
            return true;
          }
          continue;
        }
        var delAt = Number(candDel[raw.id]) || 0;
        var explicitEdit = Math.max(raw.u || 0, raw.nu || 0, raw.cu || 0);
        if (!delAt || explicitEdit > delAt) return true;
      }
    }
    return false;
  }

  async ensureBackupUpdated(statePayloadObj, isPreDelete) {
    try {
      if (this.readingDeviceMode || !this.ownFileExistsOnDisk) return;
      var now = Date.now();
      var today = getDateStringFromMs(now);

      var existingBackup = await this.readParsedFile(BACKUP_PATH);
      var existingCount = existingBackup ? countTotalItems(existingBackup.hl) : 0;
      var candidateCount = countTotalItems(statePayloadObj.hl);

      if (isPreDelete) {
        if (!existingBackup || !this.hasUnaccountedBackupData(existingBackup, statePayloadObj)) {
          var preBytes = await compressTextBytes(JSON.stringify(statePayloadObj));
          await this.writeBytesDirectSafe(BACKUP_PATH, preBytes);
          this.todayBackupDoneDate = today;
          this.preDeleteBackupHoldUntil = now + 24 * 3600 * 1000;
        }
        return;
      }

      if (now < this.preDeleteBackupHoldUntil) return;
      if (this.todayBackupDoneDate === today) {
        if (existingBackup) await this.pruneRetiredPeerFiles(existingBackup);
        return;
      }

      var backupStale = !existingBackup || now - (existingBackup.u || 0) > 36 * 3600 * 1000;
      if (!backupStale && !this.isBackupLeader()) return;

      if (existingBackup) {
        var bakDate = getDateStringFromMs(existingBackup.u || 0);
        if (bakDate === today && candidateCount <= existingCount) {
          this.todayBackupDoneDate = today;
          await this.pruneRetiredPeerFiles(existingBackup);
          return;
        }
        if (this.hasUnaccountedBackupData(existingBackup, statePayloadObj)) return;
      }

      var bytes = await compressTextBytes(JSON.stringify(statePayloadObj));
      await this.writeBytesDirectSafe(BACKUP_PATH, bytes);
      this.todayBackupDoneDate = today;
      await this.pruneRetiredPeerFiles(statePayloadObj);
    } catch (e) {
      console.warn("[Highlighter] Backup update notice:", e);
    }
  }

  async pruneRetiredPeerFiles(backupData) {
    try {
      if (this.readingDeviceMode || !backupData || !this.ownFileExistsOnDisk || !this.isBackupLeader()) return;
      var now = Date.now();
      if (now - this.lastPruneCheckAt < 3600000) return;
      this.lastPruneCheckAt = now;

      var retireAgeMs = 45 * 24 * 60 * 60 * 1000;
      var adapter = this.app.vault.adapter;
      var listing = await adapter.list("");
      var files = listing?.files || [];
      var currentPayload = this.buildEncodedStatePayload();

      for (var i = 0; i < files.length; i++) {
        var fPath = normalizePath(files[i]);
        if (this.classifySyncFile(fPath) !== "peer") continue;

        var peerData = await this.readParsedFile(fPath);
        if (!peerData) continue;

        var isSelfDuplicate = peerData.d === this.deviceId;
        var peerTs = peerData.u || 0;
        if (!isSelfDuplicate) {
          var stat = await adapter.stat(fPath);
          if (!stat || now - stat.mtime < retireAgeMs || now - peerTs < retireAgeMs) continue;
        }

        if (this.lastOwnWriteAt < peerTs || (backupData.u || 0) < peerTs) continue;
        if (this.mergeStatePayloadIntoMemory(peerData).changed) continue;
        if (this.hasUnaccountedBackupData(peerData, backupData)) continue;
        if (this.hasUnaccountedBackupData(peerData, currentPayload)) continue;

        await adapter.remove(fPath);
        this.seenSyncFileMeta.delete(fPath);
        if (!isSelfDuplicate && peerData.d) this.peerDeviceActivity.delete(peerData.d);
      }
    } catch (e) {}
  }

  async saveAnnotationsNow() {
    if (this.readingDeviceMode) return;
    this.localDirty = true;
    window.clearTimeout(this.textSaveTimer);
    window.clearTimeout(this.viewStateSaveTimer);
    this.textSaveTimer = null;
    this.viewStateSaveTimer = null;
    await this.flushSyncWriteNow();
  }

  scheduleTypingSave() {
    if (this.readingDeviceMode) return;
    this.localDirty = true;
    window.clearTimeout(this.textSaveTimer);
    this.textSaveTimer = window.setTimeout(() => {
      this.textSaveTimer = null;
      this.flushSyncWriteNow();
    }, 2000);
  }

  async flushSyncWriteNow(opts) {
    if (this.readingDeviceMode) return;
    if (opts && opts.allowMirrorRefresh) this._pendingMirrorRefresh = true;
    if (this.isWritingSyncFile) {
      this.writeQueued = true;
      return;
    }

    this.isWritingSyncFile = true;
    try {
      do {
        this.writeQueued = false;
        var mirrorFlag = !!this._pendingMirrorRefresh;
        this._pendingMirrorRefresh = false;
        await this.writeDeviceSyncFileInternal(mirrorFlag);
      } while (this.writeQueued);
    } finally {
      this.isWritingSyncFile = false;
    }
  }

  async writeDeviceSyncFileInternal(allowMirrorRefresh) {
    try {
      if (this.readingDeviceMode) {
        this.localDirty = false;
        this.localViewStateDirty = false;
        return;
      }

      var peerScan = await this.readAllRootSyncFiles(false);
      if (peerScan.ownConflicts.length > 0) this.localDirty = true;

      var shouldWrite =
        this.localDirty ||
        this.localViewStateDirty ||
        (allowMirrorRefresh && this.needsPeerMirrorRefresh && this.ownFileExistsOnDisk);

      if (!shouldWrite) return;

      var currentCount = countTotalItems(this.pdfHighlights);
      if (this.lastCommittedItemCount > 0 && currentCount === 0 && !this.hasExplicitUserDeletion) {
        var bak = await this.readParsedFile(BACKUP_PATH);
        if (bak && countTotalItems(bak.hl) > 0) this.mergeStatePayloadIntoMemory(bak);
        this.localDirty = false;
        return;
      }

      var isMassDelete =
        this.lastCommittedPayloadObj &&
        this.lastCommittedItemCount - currentCount >= 10 &&
        this.hasExplicitUserDeletion;

      var payloadObj = this.buildEncodedStatePayload();
      var digest = JSON.stringify({ hl: payloadObj.hl, del: payloadObj.del, mv: payloadObj.mv, vs: payloadObj.vs });

      if (this.ownFileExistsOnDisk && digest === this.lastSavedDigest) {
        this.localDirty = false;
        this.localViewStateDirty = false;
        this.needsPeerMirrorRefresh = false;
        if (peerScan.ownConflicts.length > 0) await this.cleanupSettledConflicts(peerScan.ownConflicts);
        return;
      }

      var bytes = await compressTextBytes(JSON.stringify(payloadObj));
      await this.writeBytesDirectSafe(this.deviceSyncPath, bytes);
      this.ownFileExistsOnDisk = true;
      this.lastOwnWriteAt = payloadObj.u;
      this.peerDeviceActivity.set(this.deviceId, { path: this.deviceSyncPath, u: payloadObj.u });

      if (peerScan.ownConflicts.length > 0) {
        await this.cleanupSettledConflicts(peerScan.ownConflicts);
      }

      if (isMassDelete) {
        await this.ensureBackupUpdated(this.lastCommittedPayloadObj, true);
      } else if (currentCount > 0 || Object.keys(this.viewStates).length > 0) {
        await this.ensureBackupUpdated(payloadObj, false);
      }

      if (peerScan.backupConflicts.length > 0 && this.isBackupLeader()) {
        await this.cleanupSettledConflicts(peerScan.backupConflicts);
      }

      this.lastCommittedItemCount = currentCount;
      this.lastCommittedPayloadObj = payloadObj;
      this.lastSavedDigest = digest;
      this.localDirty = false;
      this.localViewStateDirty = false;
      this.needsPeerMirrorRefresh = false;
      this.hasExplicitUserDeletion = false;
    } catch (err) {
      console.error("[Highlighter] Failed to write sync file:", err);
    }
  }

  // --- UNDO / REDO HISTORY ENGINE ---
  pushHistory(filePath) {
    if (this.readingDeviceMode) return;
    var p = normalizePath(filePath);
    if (!this.history.has(p)) this.history.set(p, { undo: [], redo: [] });
    var h = this.history.get(p);
    var current = JSON.stringify(this.pdfHighlights[p] || []);
    if (h.undo.length === 0 || h.undo[h.undo.length - 1] !== current) {
      h.undo.push(current);
      if (h.undo.length > 50) h.undo.shift();
      h.redo = [];
    }
  }

  undo(filePath) {
    if (this.readingDeviceMode) return;
    var p = normalizePath(filePath);
    var h = this.history.get(p);
    if (!h || !h.undo.length) return;

    this.closeNotePopover(false);
    this.hideAddNotePill();

    var current = JSON.stringify(this.pdfHighlights[p] || []);
    var prevJson = h.undo.pop();
    while (prevJson === current && h.undo.length > 0) prevJson = h.undo.pop();
    if (prevJson === current) return;
    h.redo.push(current);

    var prevItems = JSON.parse(prevJson);
    var now = this.nowTs();
    var prevIds = new Set();

    for (var i = 0; i < prevItems.length; i++) {
      prevIds.add(prevItems[i].id);
      prevItems[i].updatedAt = now;
      this.sessionErasedIds.delete(prevItems[i].id);
      delete this.deletedIds[prevItems[i].id];
    }

    var curItems = this.pdfHighlights[p] || [];
    for (var j = 0; j < curItems.length; j++) {
      if (curItems[j]?.id && !prevIds.has(curItems[j].id)) {
        this.deletedIds[curItems[j].id] = now;
        this.hasExplicitUserDeletion = true;
      }
    }

    this.pdfHighlights[p] = prevItems;
    this.renderDataVersion++;
    this.scheduleAllPdfRender(true);
    this.saveAnnotationsNow();
  }

  redo(filePath) {
    if (this.readingDeviceMode) return;
    var p = normalizePath(filePath);
    var h = this.history.get(p);
    if (!h || !h.redo.length) return;

    this.closeNotePopover(false);
    this.hideAddNotePill();

    var current = JSON.stringify(this.pdfHighlights[p] || []);
    h.undo.push(current);

    var nextItems = JSON.parse(h.redo.pop());
    var now = this.nowTs();
    var nextIds = new Set();

    for (var i = 0; i < nextItems.length; i++) {
      nextIds.add(nextItems[i].id);
      nextItems[i].updatedAt = now;
      delete this.deletedIds[nextItems[i].id];
    }

    var curItems = this.pdfHighlights[p] || [];
    for (var j = 0; j < curItems.length; j++) {
      if (curItems[j]?.id && !nextIds.has(curItems[j].id)) {
        this.deletedIds[curItems[j].id] = now;
        this.hasExplicitUserDeletion = true;
      }
    }

    this.pdfHighlights[p] = nextItems;
    this.renderDataVersion++;
    this.scheduleAllPdfRender(true);
    this.saveAnnotationsNow();
  }

  // --- SHORTCUT DISPATCHER ---
  handleKeyDown(e) {
    if (this.readingDeviceMode) return;
    var activeEl = document.activeElement;
    if (activeEl) {
      if (activeEl.closest(".modal, .modal-container, .prompt, .suggestion-container, .popover, .menu")) return;
      if (activeEl.closest(".drive-note-popover")) return;
      if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") return;
      if (activeEl.closest(".search-input-container, .workspace-leaf-content[data-type='search']")) return;
    }

    var hk = this.settings.hotkeys || DEFAULT_SETTINGS.hotkeys;

    if (activeEl && activeEl.classList.contains("drive-text-box")) {
      var isMod = e.ctrlKey || e.metaKey;
      var boxKey = e.key?.toLowerCase();

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        activeEl.blur();
        return;
      }
      if (isMod && !e.altKey) {
        if (boxKey === (hk.bold || "b").toLowerCase()) { e.preventDefault(); this.toggleTextFormatting("bold"); return; }
        if (boxKey === (hk.italic || "i").toLowerCase()) { e.preventDefault(); this.toggleTextFormatting("italic"); return; }
        if (boxKey === (hk.underline || "u").toLowerCase()) { e.preventDefault(); this.toggleTextFormatting("underline"); return; }
      }
      if (e.altKey && !isMod) {
        if (boxKey === (hk.align || "a").toLowerCase()) { e.preventDefault(); this.cycleTextAlignment(); return; }
        if (boxKey === (hk.bullets || "8").toLowerCase()) { e.preventDefault(); this.toggleList("bullet"); return; }
        if (boxKey === (hk.numbers || "7").toLowerCase()) { e.preventDefault(); this.toggleList("number"); return; }
      }
      if (isMod || e.altKey) {
        if (e.key === "-" || boxKey === (hk.sizeDown || "-").toLowerCase()) { e.preventDefault(); this.adjustFontSize(-2); return; }
        if (e.key === "=" || e.key === "+" || boxKey === (hk.sizeUp || "=").toLowerCase()) { e.preventDefault(); this.adjustFontSize(2); return; }
      }
      return;
    }

    var targetLeaf = this.hoveredPdfLeaf;
    if (!targetLeaf) {
      var currentActive = this.app.workspace.activeLeaf;
      if (currentActive?.view?.getViewType?.() === "pdf") targetLeaf = currentActive;
    }
    if (!targetLeaf) return;

    if (activeEl && activeEl.closest(".pdf-toolbar, .pdf-findbar")) {
      if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") return;
    }

    var file = this.getLeafFile(targetLeaf);
    if (!file || file.extension !== "pdf") return;

    var isModifier = e.ctrlKey || e.metaKey;

    if (isModifier && !e.altKey && e.key?.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.undo(file.path);
      return;
    }

    if (
      (isModifier && !e.altKey && e.key?.toLowerCase() === "y") ||
      (isModifier && !e.altKey && e.shiftKey && e.key?.toLowerCase() === "z")
    ) {
      e.preventDefault();
      e.stopPropagation();
      this.redo(file.path);
      return;
    }

    if (this.activeTool === "text" && !isModifier) {
      if (e.key === "-" || e.key === (hk.sizeDown || "-")) { e.preventDefault(); e.stopPropagation(); this.adjustFontSize(-2); return; }
      if (e.key === "=" || e.key === "+" || e.key === (hk.sizeUp || "=")) { e.preventDefault(); e.stopPropagation(); this.adjustFontSize(2); return; }
    }

    if (isModifier || e.altKey) return;

    var key = e.key?.toLowerCase();

    if (
      key === "n" &&
      (this.activeTool === "select" || this.activeTool === "highlighter") &&
      this.hoveredHighlight &&
      this.notePopover?.mode !== "edit"
    ) {
      e.preventDefault();
      e.stopPropagation();
      var hh = this.hoveredHighlight;
      this.openNotePopover("edit", hh.filePath, hh.pageNum, hh.item, hh.pageEl);
      return;
    }

    var isColorKey = /^[1-9]$/.test(e.key);
    var isToolKey =
      key === (hk.text || "t").toLowerCase() ||
      key === (hk.select || "v").toLowerCase() ||
      key === (hk.pen || "p").toLowerCase() ||
      key === (hk.highlighter || "h").toLowerCase() ||
      key === (hk.eraser || "e").toLowerCase();

    if (!isColorKey && !isToolKey) return;

    e.preventDefault();
    e.stopPropagation();

    if (activeEl && typeof activeEl.blur === "function" && activeEl !== document.body) activeEl.blur();
    if (this.app.workspace.activeLeaf !== targetLeaf) {
      this.app.workspace.setActiveLeaf(targetLeaf, { focus: false });
    }

    if (isColorKey) {
      var index = parseInt(e.key, 10) - 1;
      if (index < this.settings.colors.length) this.setColor(this.settings.colors[index]?.color);
      return;
    }

    if (key === (hk.text || "t").toLowerCase()) this.setTool("text");
    else if (key === (hk.select || "v").toLowerCase()) this.setTool("select");
    else if (key === (hk.pen || "p").toLowerCase()) this.setTool("pen");
    else if (key === (hk.highlighter || "h").toLowerCase()) this.setTool("highlighter");
    else if (key === (hk.eraser || "e").toLowerCase()) this.setTool("eraser");
  }

  setTool(toolId) {
    if (this.readingDeviceMode) toolId = "none";
    if (this.activeTool === toolId && toolId !== "none") toolId = "none";
    if (this.activeEditingBox && toolId !== "text") this.activeEditingBox.blur();

    this.commitAndCloseNotePopover();
    this.hideAddNotePill();
    this.hoveredHighlight = null;

    this.activeTool = toolId;
    var isTextMode = toolId === "text";

    document.querySelectorAll(".drive-pdf-toolbar-group").forEach((group) => {
      if (isTextMode) group.addClass("is-text-mode");
      else group.removeClass("is-text-mode");

      group.querySelectorAll(".drive-tool-btn").forEach((btn) => {
        btn.blur();
        if (btn.getAttribute("data-tool") === toolId) btn.addClass("is-active");
        else btn.removeClass("is-active");
      });
    });

    document.querySelectorAll(".drive-text-box").forEach((b) => {
      b.setAttribute("contenteditable", isTextMode ? "true" : "false");
    });

    this.updateCursorMode();
  }

  setColor(color) {
    if (this.readingDeviceMode || !color) return;
    this.activeColor = color;
    document.querySelectorAll(".drive-pdf-toolbar-group .drive-color-swatch-mini").forEach((s) => {
      s.blur();
      if (s.getAttribute("data-color") === color) s.addClass("is-active");
      else s.removeClass("is-active");
    });

    var targetBox =
      this.activeEditingBox ||
      (this.activeTextBoxId ? document.querySelector(`.drive-text-box[data-id="${this.activeTextBoxId}"]`) : null);
    if (targetBox) {
      targetBox.style.color = color;
      var file = this.getActivePdfFileFallback();
      var id = targetBox.getAttribute("data-id");
      if (file && id) {
        var normPath = normalizePath(file.path);
        var items = this.pdfHighlights[normPath] || [];
        var match = items.find((i) => i.id === id);
        if (match && match.color !== color) {
          match.color = color;
          match.updatedAt = this.nowTs();
          this.saveAnnotationsNow();
        }
      }
    }
  }

  injectIntoAllLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!leaf.isDeferred && leaf.view?.getViewType?.() === "pdf") {
        this.injectIntoNativeToolbar(leaf);
      }
    });
  }

  injectIntoNativeToolbar(leaf) {
    if (!leaf || leaf.isDeferred || !leaf.view || leaf.view.getViewType?.() !== "pdf") return;
    var container = leaf.view.containerEl;
    if (!container) return;
    var nativeToolbar =
      container.querySelector(".pdf-toolbar-right") ||
      container.querySelector(".pdf-toolbar") ||
      container.querySelector(".toolbar");
    if (!nativeToolbar) return;

    var existingGroup = nativeToolbar.querySelector(".drive-pdf-toolbar-group");
    if (this.readingDeviceMode) {
      if (existingGroup) existingGroup.remove();
      return;
    }

    if (existingGroup) {
      if (this.activeTool === "text") existingGroup.addClass("is-text-mode");
      else existingGroup.removeClass("is-text-mode");

      existingGroup.querySelectorAll(".drive-tool-btn").forEach((btn) => {
        if (btn.getAttribute("data-tool") === this.activeTool) btn.addClass("is-active");
        else btn.removeClass("is-active");
      });
      existingGroup.querySelectorAll(".drive-color-swatch-mini").forEach((s) => {
        if (s.getAttribute("data-color") === this.activeColor) s.addClass("is-active");
        else s.removeClass("is-active");
      });
      return;
    }

    this.suppressMutationDepth++;
    try {
      var group = document.createElement("div");
      group.className = "drive-pdf-toolbar-group";
      if (this.activeTool === "text") group.addClass("is-text-mode");

      var hk = this.settings.hotkeys || DEFAULT_SETTINGS.hotkeys;

      var textToggleBtn = group.createEl("button", {
        cls: `clickable-icon drive-tool-btn ${this.activeTool === "text" ? "is-active" : ""}`
      });
      textToggleBtn.setAttribute("data-tool", "text");
      obsidian.setIcon(textToggleBtn, "type");
      textToggleBtn.setAttribute("aria-label", `Text Tool (${(hk.text || "t").toUpperCase()})`);
      textToggleBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      textToggleBtn.onclick = (e) => { e.stopPropagation(); textToggleBtn.blur(); this.setTool("text"); };

      group.createEl("div", { cls: "drive-bar-divider" });

      var primaryToolsGroup = group.createEl("div", { cls: "drive-primary-tools" });
      var primaryTools = [
        { id: "select", icon: "mouse-pointer", tip: `Select (${(hk.select || "v").toUpperCase()})` },
        { id: "highlighter", icon: "highlighter", tip: `Highlighter (${(hk.highlighter || "h").toUpperCase()})` },
        { id: "pen", icon: "pencil", tip: `Pen (${(hk.pen || "p").toUpperCase()})` },
        { id: "eraser", icon: "eraser", tip: `Eraser (${(hk.eraser || "e").toUpperCase()})` }
      ];

      primaryTools.forEach((t) => {
        var btn = primaryToolsGroup.createEl("button", {
          cls: `clickable-icon drive-tool-btn ${this.activeTool === t.id ? "is-active" : ""}`
        });
        btn.setAttribute("data-tool", t.id);
        obsidian.setIcon(btn, t.icon);
        btn.setAttribute("aria-label", t.tip);
        btn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
        btn.onclick = (e) => { e.stopPropagation(); btn.blur(); this.setTool(t.id); };
      });

      var textModeGroup = group.createEl("div", { cls: "drive-text-mode-tools" });

      var sizeDownBtn = textModeGroup.createEl("button", { cls: "clickable-icon drive-tool-btn" });
      obsidian.setIcon(sizeDownBtn, "minus");
      sizeDownBtn.setAttribute("aria-label", "Smaller Text (-)");
      sizeDownBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      sizeDownBtn.onclick = (e) => { e.stopPropagation(); sizeDownBtn.blur(); this.adjustFontSize(-2); };

      var sizeUpBtn = textModeGroup.createEl("button", { cls: "clickable-icon drive-tool-btn" });
      obsidian.setIcon(sizeUpBtn, "plus");
      sizeUpBtn.setAttribute("aria-label", "Larger Text (=)");
      sizeUpBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      sizeUpBtn.onclick = (e) => { e.stopPropagation(); sizeUpBtn.blur(); this.adjustFontSize(2); };

      var alignBtn = textModeGroup.createEl("button", { cls: "clickable-icon drive-tool-btn drive-text-align" });
      this.updateAlignButtonIcon(alignBtn, this.settings.textFormatting.align || "left");
      alignBtn.setAttribute("aria-label", "Cycle Alignment");
      alignBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      alignBtn.onclick = (e) => { e.stopPropagation(); alignBtn.blur(); this.cycleTextAlignment(); };

      var bulletBtn = textModeGroup.createEl("button", { cls: "clickable-icon drive-tool-btn" });
      obsidian.setIcon(bulletBtn, "list");
      bulletBtn.setAttribute("aria-label", "Bullet List");
      bulletBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      bulletBtn.onclick = (e) => { e.stopPropagation(); bulletBtn.blur(); this.toggleList("bullet"); };

      var numberBtn = textModeGroup.createEl("button", { cls: "clickable-icon drive-tool-btn" });
      obsidian.setIcon(numberBtn, "list-ordered");
      numberBtn.setAttribute("aria-label", "Numbered List");
      numberBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      numberBtn.onclick = (e) => { e.stopPropagation(); numberBtn.blur(); this.toggleList("number"); };

      group.createEl("div", { cls: "drive-bar-divider" });

      var colorGroup = group.createEl("div", { cls: "drive-color-group" });
      this.renderToolbarColors(colorGroup);

      nativeToolbar.appendChild(group);
    } finally {
      this.suppressMutationDepth--;
    }
  }

  updateAlignButtonIcon(btn, align) {
    btn.empty();
    if (align === "center") obsidian.setIcon(btn, "align-center");
    else if (align === "right") obsidian.setIcon(btn, "align-right");
    else obsidian.setIcon(btn, "align-left");
  }

  toggleTextFormatting(prop) {
    if (this.readingDeviceMode) return;
    var cur = !this.settings.textFormatting[prop];
    this.settings.textFormatting[prop] = cur;

    var targetBox =
      this.activeEditingBox ||
      (this.activeTextBoxId ? document.querySelector(`.drive-text-box[data-id="${this.activeTextBoxId}"]`) : null);
    if (targetBox) {
      var file = this.getActivePdfFileFallback();
      var id = targetBox.getAttribute("data-id");
      if (file && id) {
        var items = this.pdfHighlights[normalizePath(file.path)] || [];
        var match = items.find((i) => i.id === id);
        if (match) {
          match[prop] = cur;
          match.updatedAt = this.nowTs();
          this.applyBoxStyle(targetBox, match);
          this.saveAnnotationsNow();
        }
      }
    }
    this.saveSettingsOnly();
  }

  adjustFontSize(delta) {
    if (this.readingDeviceMode) return;
    var cur = (this.settings.textFormatting.fontSize || 16) + delta;
    cur = Math.max(8, Math.min(64, cur));
    this.settings.textFormatting.fontSize = cur;

    var targetBox =
      this.activeEditingBox ||
      (this.activeTextBoxId ? document.querySelector(`.drive-text-box[data-id="${this.activeTextBoxId}"]`) : null);
    if (targetBox) {
      var file = this.getActivePdfFileFallback();
      var id = targetBox.getAttribute("data-id");
      if (file && id) {
        var items = this.pdfHighlights[normalizePath(file.path)] || [];
        var match = items.find((i) => i.id === id);
        if (match) {
          match.fontSize = cur;
          match.updatedAt = this.nowTs();
          this.applyBoxStyle(targetBox, match);
          this.saveAnnotationsNow();
        }
      }
    }
    this.saveSettingsOnly();
  }

  cycleTextAlignment() {
    if (this.readingDeviceMode) return;
    var order = ["left", "center", "right"];
    var targetBox =
      this.activeEditingBox ||
      (this.activeTextBoxId ? document.querySelector(`.drive-text-box[data-id="${this.activeTextBoxId}"]`) : null);
    var currentAlign = (targetBox && targetBox.style.textAlign) || this.settings.textFormatting.align || "left";
    var idx = order.indexOf(currentAlign);
    var next = order[(idx + 1) % order.length];
    this.settings.textFormatting.align = next;

    document.querySelectorAll(".drive-text-mode-tools .drive-text-align").forEach((btn) => {
      this.updateAlignButtonIcon(btn, next);
    });

    if (targetBox) {
      targetBox.style.textAlign = next;
      var file = this.getActivePdfFileFallback();
      var id = targetBox.getAttribute("data-id");
      if (file && id) {
        var normPath = normalizePath(file.path);
        var items = this.pdfHighlights[normPath] || [];
        var match = items.find((i) => i.id === id);
        if (match) {
          match.align = next;
          match.updatedAt = this.nowTs();
          this.saveAnnotationsNow();
        }
      }
    }
    this.saveSettingsOnly();
  }

  toggleList(type) {
    if (this.readingDeviceMode) return;
    var targetBox =
      this.activeEditingBox ||
      (this.activeTextBoxId ? document.querySelector(`.drive-text-box[data-id="${this.activeTextBoxId}"]`) : null);
    if (!targetBox) return;

    var text = targetBox.innerText;
    var lines = text.split("\n");

    if (type === "bullet") {
      var hasBullets = lines.some((l) => l.trim().startsWith("•"));
      if (hasBullets) {
        lines = lines.map((l) => l.replace(/^(\s*)•\s?/, "$1"));
      } else {
        lines = lines.map((l) => {
          var cleaned = l.replace(/^(\s*)(•|\d+\.)\s?/, "$1");
          return cleaned.trim() ? "• " + cleaned : cleaned;
        });
      }
    } else if (type === "number") {
      var hasNumbers = lines.some((l) => /^\s*\d+\.\s/.test(l));
      if (hasNumbers) {
        lines = lines.map((l) => l.replace(/^(\s*)\d+\.\s?/, "$1"));
      } else {
        var count = 1;
        lines = lines.map((l) => {
          var cleaned = l.replace(/^(\s*)(•|\d+\.)\s?/, "$1");
          if (cleaned.trim()) return count++ + ". " + cleaned;
          return cleaned;
        });
      }
    }

    targetBox.innerText = lines.join("\n");
    var file = this.getActivePdfFileFallback();
    var id = targetBox.getAttribute("data-id");
    if (file && id) {
      var normPath = normalizePath(file.path);
      var items = this.pdfHighlights[normPath] || [];
      var match = items.find((i) => i.id === id);
      if (match) {
        match.text = targetBox.innerText;
        match.updatedAt = this.nowTs();
        this.saveAnnotationsNow();
      }
    }
  }

  renderToolbarColors(colorGroup) {
    colorGroup.empty();
    (this.settings.colors || []).forEach((c, idx) => {
      var swatch = colorGroup.createEl("button", {
        cls: `drive-color-swatch-mini ${this.activeColor === c?.color ? "is-active" : ""}`
      });
      swatch.style.backgroundColor = c?.color || "#ffe066";
      swatch.setAttribute("data-color", c?.color || "#ffe066");
      var keyHint = idx < 9 ? ` (${idx + 1})` : "";
      swatch.setAttribute("aria-label", `${c?.name || "Color"}${keyHint}`);
      swatch.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      swatch.onclick = (e) => { e.stopPropagation(); swatch.blur(); this.setColor(c?.color); };
    });
  }

  updateAllToolbarColors() {
    document.querySelectorAll(".drive-pdf-toolbar-group .drive-color-group").forEach((group) => {
      this.renderToolbarColors(group);
    });
  }

  updateCursorMode() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.isDeferred || leaf.view?.getViewType?.() !== "pdf") return;
      var container = leaf.view?.containerEl;
      if (!container) return;
      var pdfContainer = container.querySelector(".pdf-container") || container;
      pdfContainer.classList.remove(
        "drive-drawing-active",
        "drive-eraser-active",
        "drive-text-active",
        "drive-select-active"
      );
      if (this.readingDeviceMode) return;
      if (this.activeTool === "pen" || this.activeTool === "highlighter") pdfContainer.classList.add("drive-drawing-active");
      else if (this.activeTool === "eraser") pdfContainer.classList.add("drive-eraser-active");
      else if (this.activeTool === "text") pdfContainer.classList.add("drive-text-active");
      else if (this.activeTool === "select") pdfContainer.classList.add("drive-select-active");
    });
  }

  // --- REAL-TIME LIVE SELECTION PREVIEW ---
  handleLiveSelectionPreview() {
    if (this.readingDeviceMode || this.activeTool !== "select") {
      this.clearLiveSelectionPreviews();
      return;
    }

    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.clearLiveSelectionPreviews();
      return;
    }

    var text = sel.toString();
    if (!text || !text.trim()) {
      this.clearLiveSelectionPreviews();
      return;
    }

    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var elem = node instanceof Element ? node : node.parentElement;
    var textLayer = elem ? elem.closest(".textLayer") : null;
    if (!textLayer) {
      this.clearLiveSelectionPreviews();
      return;
    }

    var viewerContainer = textLayer.closest(".pdf-viewer, .pdf-container") || document;
    var pages = Array.from(viewerContainer.querySelectorAll(".page[data-page-number]"));
    this.clearLiveSelectionPreviews();

    var rectsByPage = new Map();
    var rects = range.getClientRects();

    for (var rIdx = 0; rIdx < rects.length; rIdx++) {
      var r = rects[rIdx];
      if (r.width <= 0 || r.height <= 0) continue;

      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var targetPage = null;
      for (var pIdx = 0; pIdx < pages.length; pIdx++) {
        var pr = pages[pIdx].getBoundingClientRect();
        if (cx >= pr.left - 8 && cx <= pr.right + 8 && cy >= pr.top - 8 && cy <= pr.bottom + 8) {
          targetPage = pages[pIdx];
          break;
        }
      }
      if (!targetPage) continue;

      var contentRect = getPageContentRect(targetPage);
      if (contentRect.width <= 0 || contentRect.height <= 0) continue;

      var wNorm = r.width / contentRect.width;
      var hNorm = r.height / contentRect.height;
      if (wNorm > 0.98 && hNorm > 0.45) continue;

      var xNorm = Math.max(0, Math.min(1, (r.left - contentRect.left) / contentRect.width));
      var yNorm = Math.max(0, Math.min(1, (r.top - contentRect.top) / contentRect.height));

      if (!rectsByPage.has(targetPage)) rectsByPage.set(targetPage, []);
      rectsByPage.get(targetPage).push({
        x: xNorm,
        y: yNorm,
        w: Math.min(1 - xNorm, wNorm),
        h: Math.min(1 - yNorm, hNorm)
      });
    }

    rectsByPage.forEach((rawRects, pageEl) => {
      var layers = this.ensureLayersAttached(pageEl);
      var vh = layers.viewHeight || 1000;
      var merged = mergeNormalizedRects(rawRects);
      for (var i = 0; i < merged.length; i++) {
        var nr = merged[i];
        var rectEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rectEl.setAttribute("class", "drive-live-preview-rect");
        rectEl.setAttribute("x", String((nr.x * 1000).toFixed(1)));
        rectEl.setAttribute("y", String((nr.y * vh).toFixed(1)));
        rectEl.setAttribute("width", String((nr.w * 1000).toFixed(1)));
        rectEl.setAttribute("height", String((nr.h * vh).toFixed(1)));
        rectEl.setAttribute("fill", this.activeColor);
        layers.highlightGroup.appendChild(rectEl);
      }
    });
  }

  clearLiveSelectionPreviews() {
    document.querySelectorAll(".drive-live-preview-rect").forEach((el) => el.remove());
  }

  // --- UNIFIED POINTER ENGINE (MOUSE + STYLUS + TEXT + HIGHLIGHT NOTES) ---
  onPointerDown(e) {
    var targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!targetEl) return;
    if (targetEl.closest(".drive-note-popover, .drive-note-add-pill, .menu, .pdf-toolbar, .pdf-findbar")) return;

    var suppressReopenId = null;
    if (this.notePopover && this.notePopover.mode === "edit") {
      suppressReopenId = this.notePopover.itemId;
      this.commitAndCloseNotePopover();
    } else if (this.notePopover && this.notePopover.mode === "preview") {
      this.closeNotePopover(false);
    }

    var pageEl = targetEl.closest(".page[data-page-number]");
    if (!pageEl) return;

    var leaf = this.getLeafForElement(pageEl) || this.app.workspace.activeLeaf;
    var file = this.getLeafFile(leaf);
    var pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
    if (!pageNum || !file) return;

    if (this.readingDeviceMode || this.activeTool === "none") {
      if (
        e.button === 0 &&
        e.detail === 1 &&
        !targetEl.closest("a, button, input, textarea, .linkAnnotation, .drive-text-box")
      ) {
        var rRect = getPageContentRect(pageEl);
        var rHit = this.findHighlightAtPoint(file.path, pageNum, rRect, e.clientX, e.clientY);
        if (rHit && rHit.item.note && rHit.item.note.trim()) {
          this.pendingReadTap = {
            x: e.clientX,
            y: e.clientY,
            pageEl: pageEl,
            filePath: file.path,
            pageNum: pageNum,
            item: rHit.item
          };
        } else {
          this.pendingReadTap = null;
        }
      } else {
        this.pendingReadTap = null;
      }
      return;
    }

    var isStylusBarrelEraser =
      e.pointerType === "pen" &&
      ((e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || e.button === 2 || e.button === 5);

    if (this.activeTool === "select" && !isStylusBarrelEraser) {
      if (
        e.button === 0 &&
        e.detail === 1 &&
        !targetEl.closest("a, button, input, textarea, .linkAnnotation, .drive-text-box")
      ) {
        var sRect = getPageContentRect(pageEl);
        var sHit = this.findHighlightAtPoint(file.path, pageNum, sRect, e.clientX, e.clientY);
        if (sHit && sHit.item.id !== suppressReopenId) {
          this.pendingHighlightClick = {
            x: e.clientX,
            y: e.clientY,
            pageEl: pageEl,
            filePath: file.path,
            pageNum: pageNum,
            hit: sHit
          };
        } else {
          this.pendingHighlightClick = null;
        }
      } else {
        this.pendingHighlightClick = null;
      }
      this.clearLiveSelectionPreviews();
      return;
    }

    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 5 && e.button !== 2) return;
    if (this.app.workspace.activeLeaf !== leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: false });
    }

    var clickedTextBox = targetEl.closest(".drive-text-box");
    if (clickedTextBox && this.activeTool === "text") return;

    if (
      document.activeElement &&
      document.activeElement !== document.body &&
      !document.activeElement.closest(".pdf-toolbar, .pdf-findbar, .drive-text-box")
    ) {
      document.activeElement.blur();
    }

    if (this.activeTool === "text" && !isStylusBarrelEraser) {
      e.preventDefault();
      e.stopPropagation();

      var tRect = getPageContentRect(pageEl);
      var unit = (tRect.width > 0 ? tRect.width : 1000) / 1000;
      var fontSizePx = (this.settings.textFormatting.fontSize || 16) * unit;
      var offsetX = 4 * unit;
      var offsetY = 2 * unit + fontSizePx * 0.65;
      var xNorm = Math.max(0, Math.min(0.95, (e.clientX - tRect.left - offsetX) / tRect.width));
      var yNorm = Math.max(0, Math.min(0.98, (e.clientY - tRect.top - offsetY) / tRect.height));

      this.createTextAnnotation(file.path, pageNum, pageEl, xNorm, yNorm);
      return;
    }

    if (e.pointerType === "touch" && !e.isPrimary) return;

    e.preventDefault();
    e.stopPropagation();

    this.activePointerId = e.pointerId;
    this.activePointerType = e.pointerType;
    if (targetEl.setPointerCapture) {
      try { targetEl.setPointerCapture(e.pointerId); } catch (err) {}
    }

    var layers = this.ensureLayersAttached(pageEl);
    var pRect = getPageContentRect(pageEl);
    var viewHeight = this.syncPageOverlayGeometry(pageEl, pRect);

    var x = Math.max(0, Math.min(1, (e.clientX - pRect.left) / pRect.width));
    var y = Math.max(0, Math.min(1, (e.clientY - pRect.top) / pRect.height));
    var pressure = typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : 0.5;

    if (this.activeTool === "eraser" || isStylusBarrelEraser) {
      this.isErasing = true;
      this.isBarrelErasing = isStylusBarrelEraser;
      this.hasErased = false;
      this.erasedSnapshotTaken = false;
      this.activePageEl = pageEl;
      this.eraseAtPosition(file.path, pageNum, pageEl, e.clientX, e.clientY);
      return;
    }

    if (this.activeTool === "pen" || this.activeTool === "highlighter") {
      this.pendingHighlighterTap = null;
      this.suppressHighlighterReopenId = suppressReopenId;
      if (this.activeTool === "highlighter" && e.button === 0) {
        var hHit = this.findHighlightAtPoint(file.path, pageNum, pRect, e.clientX, e.clientY);
        if (hHit) {
          this.pendingHighlighterTap = {
            x: e.clientX,
            y: e.clientY,
            filePath: file.path,
            pageNum: pageNum,
            hit: hHit,
            pageEl: pageEl,
            moved: false
          };
        }
      }

      this.isDrawing = true;
      this.activePageEl = pageEl;
      this.activeSvgViewHeight = viewHeight;
      var isHighlighter = this.activeTool === "highlighter";
      var baseWidth = isHighlighter ? 14 : 2.5;
      if (e.pointerType === "pen" && !isHighlighter) baseWidth = baseWidth * (0.6 + 0.8 * pressure);

      this.currentStroke = {
        id: makeShortId(),
        type: "ink",
        isHighlighter: isHighlighter,
        page: pageNum,
        color: this.activeColor,
        width: baseWidth,
        points: [[x, y], [x, y]],
        updatedAt: this.nowTs()
      };

      var targetGroup = isHighlighter ? layers.highlightGroup : layers.penGroup;
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", this.currentStroke.color);
      path.setAttribute("stroke-width", String(this.currentStroke.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute(
        "d",
        `M ${(x * 1000).toFixed(1)} ${(y * viewHeight).toFixed(1)} L ${(x * 1000).toFixed(1)} ${(y * viewHeight).toFixed(1)}`
      );
      targetGroup.appendChild(path);
      this.activeStrokeEl = path;
    }
  }

  onPointerMove(e) {
    if (this.pendingReadTap) {
      if (Math.hypot(e.clientX - this.pendingReadTap.x, e.clientY - this.pendingReadTap.y) >= 4) {
        this.pendingReadTap = null;
      }
    }

    if (this.pendingHighlightClick) {
      if (Math.hypot(e.clientX - this.pendingHighlightClick.x, e.clientY - this.pendingHighlightClick.y) >= 4) {
        this.pendingHighlightClick = null;
      }
    }

    if (this.pendingHighlighterTap && !this.pendingHighlighterTap.moved) {
      if (Math.hypot(e.clientX - this.pendingHighlighterTap.x, e.clientY - this.pendingHighlighterTap.y) >= 4) {
        this.pendingHighlighterTap.moved = true;
      }
    }

    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    if (!this.readingDeviceMode && this.isErasing) {
      var targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
      var pageEl = targetEl?.closest(".page[data-page-number]") || this.activePageEl;
      if (!pageEl) return;
      var leaf = this.getLeafForElement(pageEl) || this.app.workspace.activeLeaf;
      var file = this.getLeafFile(leaf);
      var pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
      if (!pageNum || !file) return;
      this.eraseAtPosition(file.path, pageNum, pageEl, e.clientX, e.clientY);
      return;
    }

    if (!this.readingDeviceMode && this.isDrawing && this.currentStroke && this.activeStrokeEl && this.activePageEl) {
      var contentRect = getPageContentRect(this.activePageEl);
      var events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      var vh = this.activeSvgViewHeight || 1000;

      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var x = Math.max(0, Math.min(1, (ev.clientX - contentRect.left) / contentRect.width));
        var y = Math.max(0, Math.min(1, (ev.clientY - contentRect.top) / contentRect.height));
        this.currentStroke.points.push([x, y]);
      }

      var pts = this.currentStroke.points;
      var d = "";
      for (var pIdx = 0; pIdx < pts.length; pIdx++) {
        var pt = pts[pIdx];
        d += (pIdx === 0 ? "M " : " L ") + (pt[0] * 1000).toFixed(1) + " " + (pt[1] * vh).toFixed(1);
      }
      this.activeStrokeEl.setAttribute("d", d);
      return;
    }

    if (
      (this.readingDeviceMode || this.activeTool === "none" || this.activeTool === "select" || this.activeTool === "highlighter") &&
      e.buttons === 0
    ) {
      this.updateHighlightHover(e);
    }
  }

  onPointerUp(e) {
    var pendingRead = this.pendingReadTap;
    this.pendingReadTap = null;

    var pendingClick = this.pendingHighlightClick;
    this.pendingHighlightClick = null;

    if (this.readingDeviceMode || this.activeTool === "none") {
      if (pendingRead && Math.hypot(e.clientX - pendingRead.x, e.clientY - pendingRead.y) < 4) {
        window.setTimeout(() => {
          var sel = window.getSelection();
          var hasSel = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
          if (!hasSel) {
            this.openNotePopover("preview", pendingRead.filePath, pendingRead.pageNum, pendingRead.item, pendingRead.pageEl);
          }
        }, 20);
      }
      return;
    }

    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    var targetEl = e.target instanceof Element ? e.target : null;
    if (targetEl && targetEl.hasPointerCapture && targetEl.hasPointerCapture(e.pointerId)) {
      try { targetEl.releasePointerCapture(e.pointerId); } catch (err) {}
    }

    this.activePointerId = null;
    this.activePointerType = null;

    if (this.isErasing) {
      this.isErasing = false;
      this.isBarrelErasing = false;
      this.activePageEl = null;
      if (this.hasErased) {
        this.renderDataVersion++;
        this.hasErased = false;
        this.scheduleAllPdfRender(true);
        this.saveAnnotationsNow();
      }
      return;
    }

    if (this.isDrawing) {
      this.isDrawing = false;
      var hTap = this.pendingHighlighterTap;
      this.pendingHighlighterTap = null;
      var suppressId = this.suppressHighlighterReopenId;
      this.suppressHighlighterReopenId = null;

      if (hTap && !hTap.moved && this.activeTool === "highlighter") {
        if (this.activeStrokeEl) this.activeStrokeEl.remove();
        this.currentStroke = null;
        this.activeStrokeEl = null;
        this.activePageEl = null;
        if (hTap.hit.item.id !== suppressId) {
          this.openNotePopover("edit", hTap.filePath, hTap.pageNum, hTap.hit.item, hTap.pageEl);
        }
        return;
      }

      var drawLeaf = this.getLeafForElement(this.activePageEl) || this.hoveredPdfLeaf || this.app.workspace.activeLeaf;
      var drawFile = this.getLeafFile(drawLeaf);
      if (drawFile && this.currentStroke && this.currentStroke.points.length > 1) {
        var normPath = normalizePath(drawFile.path);
        this.currentStroke.points = simplifyStrokePoints(this.currentStroke.points, 0.00045);
        this.currentStroke.updatedAt = this.nowTs();
        this.pushHistory(normPath);
        if (!this.pdfHighlights[normPath]) this.pdfHighlights[normPath] = [];
        this.pdfHighlights[normPath].push(this.currentStroke);
        this.ensureSignatureForPath(normPath);
        this.renderDataVersion++;
        this.scheduleAllPdfRender(true);
        this.saveAnnotationsNow();
      }

      this.currentStroke = null;
      this.activeStrokeEl = null;
      this.activePageEl = null;
      return;
    }

    if (pendingClick) {
      var dist = Math.hypot(e.clientX - pendingClick.x, e.clientY - pendingClick.y);
      if (dist < 4) {
        window.setTimeout(() => {
          var sel = window.getSelection();
          var hasSel = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
          if (!hasSel) {
            this.openNotePopover("edit", pendingClick.filePath, pendingClick.pageNum, pendingClick.hit.item, pendingClick.pageEl);
          } else if (this.activeTool === "select") {
            this.applyInstantTextHighlight();
          }
        }, 20);
        return;
      }
    }

    if (this.activeTool === "select") {
      window.setTimeout(() => this.applyInstantTextHighlight(), 20);
    }
  }

  onPointerCancel(e) {
    this.pendingReadTap = null;
    this.pendingHighlightClick = null;
    this.pendingHighlighterTap = null;
    this.onPointerUp(e);
  }

  onContextMenu(e) {
    if (this.readingDeviceMode) return;
    if (this.activeTool !== "select" && this.activeTool !== "highlighter") return;
    var targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!targetEl) return;
    if (targetEl.closest(".drive-note-popover, .drive-text-box, a, button, input, textarea")) return;

    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

    var pageEl = targetEl.closest(".page[data-page-number]");
    if (!pageEl) return;

    var leaf = this.getLeafForElement(pageEl) || this.app.workspace.activeLeaf;
    var file = this.getLeafFile(leaf);
    var pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
    if (!file || !pageNum) return;

    var contentRect = getPageContentRect(pageEl);
    var hit = this.findHighlightAtPoint(file.path, pageNum, contentRect, e.clientX, e.clientY);
    if (!hit) return;

    e.preventDefault();
    e.stopPropagation();

    var item = hit.item;
    var hasNote = !!(item.note && item.note.trim());
    var menu = new obsidian.Menu();

    menu.addItem((m) =>
      m.setTitle(hasNote ? "Edit note" : "Add note").setIcon(hasNote ? "pencil" : "message-square-plus")
        .onClick(() => this.openNotePopover("edit", file.path, pageNum, item, pageEl))
    );

    if (hasNote) {
      menu.addItem((m) =>
        m.setTitle("Remove note").setIcon("message-square-off")
          .onClick(() => this.saveHighlightNote(file.path, item, ""))
      );
    }

    menu.addSeparator();
    (this.settings.colors || []).forEach((c) => {
      menu.addItem((m) =>
        m.setTitle(`Color: ${c.name || c.color}`).setChecked(item.color === c.color)
          .onClick(() => this.changeHighlightColor(file.path, item, c.color))
      );
    });

    if (item.text && item.text.trim()) {
      menu.addSeparator();
      menu.addItem((m) =>
        m.setTitle("Copy highlighted text").setIcon("copy").onClick(async () => {
          try {
            await navigator.clipboard.writeText(item.text);
            new obsidian.Notice("Copied highlighted text");
          } catch (err) {}
        })
      );
    }

    menu.addSeparator();
    menu.addItem((m) =>
      m.setTitle("Delete highlight").setIcon("trash").onClick(() => this.deleteHighlightItem(file.path, item))
    );

    menu.showAtMouseEvent(e);
  }

  // --- WORKSHEET TEXT ANNOTATION & OUTLINE DRAG ENGINE ---
  createTextAnnotation(filePath, pageNum, pageEl, xNorm, yNorm) {
    if (this.readingDeviceMode) return;
    var normPath = normalizePath(filePath);
    var layers = this.ensureLayersAttached(pageEl);

    var item = {
      id: makeShortId(),
      type: "text",
      page: pageNum,
      x: xNorm,
      y: yNorm,
      text: "",
      color: this.activeColor,
      fontSize: this.settings.textFormatting.fontSize || 16,
      bold: !!this.settings.textFormatting.bold,
      italic: !!this.settings.textFormatting.italic,
      underline: !!this.settings.textFormatting.underline,
      align: this.settings.textFormatting.align || "left",
      updatedAt: this.nowTs(),
      _unpersistedEmpty: true
    };

    this.pushHistory(normPath);
    if (!this.pdfHighlights[normPath]) this.pdfHighlights[normPath] = [];
    this.pdfHighlights[normPath].push(item);
    this.ensureSignatureForPath(normPath);
    this.renderDataVersion++;

    var boxEl = this.renderSingleTextBox(layers.textLayer, item, normPath);
    this.enterTextEditMode(boxEl);
  }

  renderSingleTextBox(layerEl, item, normPath) {
    var existing = layerEl.querySelector(`[data-id="${item.id}"]`);
    if (existing) existing.remove();

    var box = document.createElement("div");
    box.className = "drive-text-box";
    box.setAttribute("data-id", item.id);
    box.setAttribute("contenteditable", !this.readingDeviceMode && this.activeTool === "text" ? "true" : "false");
    box.setAttribute("spellcheck", "false");
    box.innerText = item.text || "";
    this.applyBoxStyle(box, item);

    var isDragging = false;
    var dragMoved = false;
    var dragStartX = 0;
    var dragStartY = 0;
    var initialItemX = item.x;
    var initialItemY = item.y;

    var getEdgeDist = () => {
      var pageEl = box.closest(".page[data-page-number]");
      var cRect = pageEl ? getPageContentRect(pageEl) : null;
      var unit = cRect && cRect.width > 0 ? cRect.width / 1000 : 1;
      var bRect = box.getBoundingClientRect();
      var base = Math.max(3, Math.min(8, 6 * unit));
      return Math.min(base, bRect.width * 0.22, bRect.height * 0.22);
    };

    box.onpointermove = (e) => {
      if (this.readingDeviceMode || this.activeTool !== "text" || isDragging) return;
      var rect = box.getBoundingClientRect();
      var edgeDist = getEdgeDist();
      var isEdge =
        e.clientX - rect.left <= edgeDist ||
        rect.right - e.clientX <= edgeDist ||
        e.clientY - rect.top <= edgeDist ||
        rect.bottom - e.clientY <= edgeDist;
      box.style.cursor = isEdge ? "move" : "text";
    };

    box.onpointerdown = (e) => {
      if (this.readingDeviceMode || this.activeTool !== "text") return;
      var rect = box.getBoundingClientRect();
      var edgeDist = getEdgeDist();
      var isEdge =
        e.clientX - rect.left <= edgeDist ||
        rect.right - e.clientX <= edgeDist ||
        e.clientY - rect.top <= edgeDist ||
        rect.bottom - e.clientY <= edgeDist;

      if (isEdge) {
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        dragMoved = false;
        this.isDraggingTextBox = true;
        box.addClass("is-moving");
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        initialItemX = item.x;
        initialItemY = item.y;

        if (box.setPointerCapture) {
          try { box.setPointerCapture(e.pointerId); } catch (err) {}
        }

        var onMove = (mv) => {
          if (!isDragging) return;
          if (!dragMoved && Math.hypot(mv.clientX - dragStartX, mv.clientY - dragStartY) > 1.5) {
            this.pushHistory(normPath);
            dragMoved = true;
          }
          var pageEl = box.closest(".page[data-page-number]");
          var cRect = getPageContentRect(pageEl);
          if (cRect.width <= 0 || cRect.height <= 0) return;
          var dx = (mv.clientX - dragStartX) / cRect.width;
          var dy = (mv.clientY - dragStartY) / cRect.height;
          item.x = Math.max(0, Math.min(0.98, initialItemX + dx));
          item.y = Math.max(0, Math.min(0.98, initialItemY + dy));
          item.updatedAt = this.nowTs();
          box.style.left = item.x * 100 + "%";
          box.style.top = item.y * 100 + "%";
        };

        var onUp = (up) => {
          if (!isDragging) return;
          isDragging = false;
          this.isDraggingTextBox = false;
          box.removeClass("is-moving");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (box.releasePointerCapture) {
            try { box.releasePointerCapture(up.pointerId); } catch (err) {}
          }
          if (dragMoved) {
            this.renderDataVersion++;
            this.saveAnnotationsNow();
          }
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }
    };

    box.oninput = () => {
      if (this.readingDeviceMode) return;
      delete item._unpersistedEmpty;
      item.text = box.innerText;
      item.updatedAt = this.nowTs();
      this.scheduleTypingSave();
    };

    box.onfocus = () => {
      if (this.readingDeviceMode || this.activeTool !== "text") { box.blur(); return; }
      this.activeEditingBox = box;
      this.activeTextBoxId = item.id;
      box.addClass("is-editing");
    };

    box.onblur = () => {
      box.removeClass("is-editing");
      if (this.activeEditingBox === box) this.activeEditingBox = null;
      if (this.readingDeviceMode) return;
      var updatedText = box.innerText.trim();
      var items = this.pdfHighlights[normPath] || [];

      if (!updatedText) {
        var wasUnpersisted = !!item._unpersistedEmpty;
        this.pdfHighlights[normPath] = items.filter((i) => i.id !== item.id);
        if (!wasUnpersisted && item.id) {
          this.deletedIds[item.id] = this.nowTs();
          this.hasExplicitUserDeletion = true;
          this.localDirty = true;
        }
        box.remove();
        this.renderDataVersion++;
      } else {
        delete item._unpersistedEmpty;
        if (item.text !== box.innerText) {
          item.text = box.innerText;
          item.updatedAt = this.nowTs();
          this.localDirty = true;
        }
      }
      if (this.localDirty) this.saveAnnotationsNow();
    };

    box.onkeydown = (e) => {
      if (this.readingDeviceMode) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        box.blur();
        return;
      }

      if (e.key === "Enter") {
        var sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          var text = box.innerText;
          var selRange = sel.getRangeAt(0);
          var preRange = selRange.cloneRange();
          preRange.selectNodeContents(box);
          preRange.setEnd(selRange.endContainer, selRange.endOffset);
          var caret = preRange.toString().length;
          var linesBefore = text.slice(0, caret).split("\n");
          var curLine = linesBefore[linesBefore.length - 1] || "";

          var bulletMatch = curLine.match(/^(\s*)•\s?(.*)$/);
          var numMatch = curLine.match(/^(\s*)(\d+)\.\s?(.*)$/);

          if (bulletMatch) {
            e.preventDefault();
            if (!bulletMatch[2].trim()) {
              var allLines = text.split("\n");
              allLines[linesBefore.length - 1] = "";
              box.innerText = allLines.join("\n");
              this.setCursorToEnd(box);
            } else {
              document.execCommand("insertText", false, "\n• ");
            }
            delete item._unpersistedEmpty;
            item.text = box.innerText;
            item.updatedAt = this.nowTs();
            this.scheduleTypingSave();
            return;
          }

          if (numMatch) {
            e.preventDefault();
            if (!numMatch[3].trim()) {
              var allNumLines = text.split("\n");
              allNumLines[linesBefore.length - 1] = "";
              box.innerText = allNumLines.join("\n");
              this.setCursorToEnd(box);
            } else {
              var next = parseInt(numMatch[2], 10) + 1;
              document.execCommand("insertText", false, `\n${next}. `);
            }
            delete item._unpersistedEmpty;
            item.text = box.innerText;
            item.updatedAt = this.nowTs();
            this.scheduleTypingSave();
            return;
          }
        }
      }
    };

    layerEl.appendChild(box);
    return box;
  }

  setCursorToEnd(el) {
    var range = document.createRange();
    var sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  applyBoxStyle(box, item) {
    box.style.left = item.x * 100 + "%";
    box.style.top = item.y * 100 + "%";
    box.style.setProperty("--hl-fs", String(item.fontSize || 16));
    box.style.fontWeight = item.bold ? "bold" : "normal";
    box.style.fontStyle = item.italic ? "italic" : "normal";
    box.style.textDecoration = item.underline ? "underline" : "none";
    box.style.textAlign = item.align || "left";
    box.style.color = item.color || "#111111";
    box.style.fontFamily = this.settings.fontFamily || DEFAULT_SETTINGS.fontFamily;
  }

  enterTextEditMode(boxEl) {
    boxEl.focus();
    this.setCursorToEnd(boxEl);
  }

  // --- PIXEL-PERFECT TEXT HIGHLIGHTING ---
  applyInstantTextHighlight() {
    if (this.readingDeviceMode || this.activeTool !== "select") {
      this.clearLiveSelectionPreviews();
      return;
    }

    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.clearLiveSelectionPreviews();
      return;
    }

    var node = sel.anchorNode;
    if (!node) return;
    var elem = node instanceof Element ? node : node.parentElement;
    var textLayer = elem ? elem.closest(".textLayer") : null;
    if (!textLayer) return;

    var viewerContainer = textLayer.closest(".pdf-viewer, .pdf-container");
    var leaf = this.getLeafForElement(textLayer) || this.hoveredPdfLeaf || this.app.workspace.activeLeaf;
    var file = this.getLeafFile(leaf);
    if (!file || file.extension !== "pdf") {
      this.clearLiveSelectionPreviews();
      return;
    }

    var range = sel.getRangeAt(0);
    var text = range.toString();
    if (!text.trim()) {
      this.clearLiveSelectionPreviews();
      return;
    }

    var pages = Array.from((viewerContainer || document).querySelectorAll(".page[data-page-number]"));
    var rectsByPage = new Map();
    var clientRects = range.getClientRects();

    for (var i = 0; i < clientRects.length; i++) {
      var cr = clientRects[i];
      if (cr.width <= 0 || cr.height <= 0) continue;

      var cx = cr.left + cr.width / 2;
      var cy = cr.top + cr.height / 2;
      var targetPage = null;

      for (var pIdx = 0; pIdx < pages.length; pIdx++) {
        var pr = pages[pIdx].getBoundingClientRect();
        if (cx >= pr.left - 8 && cx <= pr.right + 8 && cy >= pr.top - 8 && cy <= pr.bottom + 8) {
          targetPage = pages[pIdx];
          break;
        }
      }
      if (!targetPage) continue;

      var contentRect = getPageContentRect(targetPage);
      if (contentRect.width <= 0 || contentRect.height <= 0) continue;

      var wNorm = cr.width / contentRect.width;
      var hNorm = cr.height / contentRect.height;
      if (wNorm > 0.98 && hNorm > 0.45) continue;

      var xNorm = (cr.left - contentRect.left) / contentRect.width;
      var yNorm = (cr.top - contentRect.top) / contentRect.height;
      if (xNorm < -0.05 || xNorm > 1.05 || yNorm < -0.05 || yNorm > 1.05) continue;

      xNorm = Math.max(0, Math.min(1, xNorm));
      yNorm = Math.max(0, Math.min(1, yNorm));

      if (!rectsByPage.has(targetPage)) rectsByPage.set(targetPage, []);
      rectsByPage.get(targetPage).push({
        x: xNorm,
        y: yNorm,
        w: Math.min(1 - xNorm, wNorm),
        h: Math.min(1 - yNorm, hNorm)
      });
    }

    if (rectsByPage.size === 0) {
      this.clearLiveSelectionPreviews();
      return;
    }

    var normPath = normalizePath(file.path);
    this.pushHistory(normPath);
    if (!this.pdfHighlights[normPath]) this.pdfHighlights[normPath] = [];

    var now = this.nowTs();
    rectsByPage.forEach((rawRects, pageEl) => {
      var pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
      if (!pageNum) return;
      var merged = mergeNormalizedRects(rawRects);
      if (merged.length === 0) return;

      this.pdfHighlights[normPath].push({
        id: makeShortId(),
        filePath: normPath,
        page: pageNum,
        text: text,
        rects: merged,
        color: this.activeColor,
        updatedAt: now
      });
    });

    this.ensureSignatureForPath(normPath);
    this.clearLiveSelectionPreviews();
    this.renderDataVersion++;
    this.scheduleAllPdfRender(true);
    this.saveAnnotationsNow();
    sel.removeAllRanges();
  }

  // --- ERASER ENGINE ---
  eraseAtPosition(filePath, pageNum, pageEl, clientX, clientY) {
    if (this.readingDeviceMode) return;
    var normPath = normalizePath(filePath);
    var items = this.pdfHighlights[normPath] || [];
    if (!items.length) return;

    var contentRect = getPageContentRect(pageEl);
    if (contentRect.width <= 0 || contentRect.height <= 0) return;

    var px = clientX - contentRect.left;
    var py = clientY - contentRect.top;
    var eraseRadius = 24;
    var eraseRadiusSq = eraseRadius * eraseRadius;
    var toDelete = new Set();

    items.forEach((item) => {
      if (item.page !== pageNum) return;

      if (item.type === "ink" && item.points) {
        for (var i = 0; i < item.points.length - 1; i++) {
          var p1x = item.points[i][0] * contentRect.width;
          var p1y = item.points[i][1] * contentRect.height;
          var p2x = item.points[i + 1][0] * contentRect.width;
          var p2y = item.points[i + 1][1] * contentRect.height;
          if (this.distToSegmentSquared(px, py, p1x, p1y, p2x, p2y) <= eraseRadiusSq) {
            toDelete.add(item.id);
            break;
          }
        }
      }

      if (item.rects) {
        for (var rIdx = 0; rIdx < item.rects.length; rIdx++) {
          var nr = item.rects[rIdx];
          var rx = nr.x * contentRect.width;
          var ry = nr.y * contentRect.height;
          var rw = nr.w * contentRect.width;
          var rh = nr.h * contentRect.height;
          if (px >= rx - eraseRadius && px <= rx + rw + eraseRadius && py >= ry - eraseRadius && py <= ry + rh + eraseRadius) {
            toDelete.add(item.id);
            break;
          }
        }
      }

      if (item.type === "text" && item.x !== undefined && item.y !== undefined) {
        var tx = item.x * contentRect.width;
        var ty = item.y * contentRect.height;
        if (Math.abs(px - tx) <= eraseRadius * 1.5 && Math.abs(py - ty) <= eraseRadius * 1.5) {
          toDelete.add(item.id);
        }
      }
    });

    if (toDelete.size > 0) {
      if (!this.erasedSnapshotTaken) {
        this.pushHistory(normPath);
        this.erasedSnapshotTaken = true;
      }

      var now = this.nowTs();
      toDelete.forEach((id) => {
        this.deletedIds[id] = now;
        this.sessionErasedIds.add(id);
      });

      this.pdfHighlights[normPath] = items.filter((a) => !toDelete.has(a.id));
      this.hasErased = true;
      this.hasExplicitUserDeletion = true;
      this.localDirty = true;
      this.renderDataVersion++;
      this.renderAllPdfViews(true);
    }
  }

  distToSegmentSquared(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var l2 = dx * dx + dy * dy;
    if (l2 === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
    var t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    var projX = x1 + t * dx;
    var projY = y1 + t * dy;
    return (px - projX) * (px - projX) + (py - projY) * (py - projY);
  }

  // --- HIGHLIGHT HIT TESTING, HOVER PREVIEW & MINIMAL NOTE POPOVER ---
  findHighlightAtPoint(filePath, pageNum, contentRect, clientX, clientY) {
    if (!contentRect || contentRect.width <= 0 || contentRect.height <= 0) return null;
    var normPath = normalizePath(filePath);
    var items = this.pdfHighlights[normPath] || [];
    if (!items.length) return null;

    var nx = (clientX - contentRect.left) / contentRect.width;
    var ny = (clientY - contentRect.top) / contentRect.height;
    var tolX = 4 / contentRect.width;
    var tolY = 4 / contentRect.height;
    var px = clientX - contentRect.left;
    var py = clientY - contentRect.top;

    for (var i = items.length - 1; i >= 0; i--) {
      var item = items[i];
      if (item.page !== pageNum || !isHighlightItem(item)) continue;

      if (item.rects && item.rects.length > 0) {
        var matchedRect = false;
        for (var rIdx = 0; rIdx < item.rects.length; rIdx++) {
          var r = item.rects[rIdx];
          if (nx >= r.x - tolX && nx <= r.x + r.w + tolX && ny >= r.y - tolY && ny <= r.y + r.h + tolY) {
            matchedRect = true;
            break;
          }
        }
        if (!matchedRect && item.note && item.note.trim()) {
          var fr = item.rects[0];
          var badgePx = (14 / 1000) * contentRect.width;
          var bx = contentRect.left + Math.min(contentRect.width - badgePx, (fr.x + fr.w) * contentRect.width - badgePx * 0.4);
          var by = contentRect.top + Math.max(0, fr.y * contentRect.height - badgePx * 0.45);
          if (clientX >= bx - 4 && clientX <= bx + badgePx + 4 && clientY >= by - 4 && clientY <= by + badgePx + 4) {
            matchedRect = true;
          }
        }
        if (matchedRect) return { item: item };
      } else if (item.type === "ink" && item.isHighlighter && item.points && item.points.length > 0) {
        var hitThreshSq = 12 * 12;
        var maxX = 0;
        var minY = 1;
        var matchedStroke = false;

        for (var pIdx = 0; pIdx < item.points.length; pIdx++) {
          maxX = Math.max(maxX, item.points[pIdx][0]);
          minY = Math.min(minY, item.points[pIdx][1]);
          if (pIdx < item.points.length - 1) {
            var p1x = item.points[pIdx][0] * contentRect.width;
            var p1y = item.points[pIdx][1] * contentRect.height;
            var p2x = item.points[pIdx + 1][0] * contentRect.width;
            var p2y = item.points[pIdx + 1][1] * contentRect.height;
            if (this.distToSegmentSquared(px, py, p1x, p1y, p2x, p2y) <= hitThreshSq) {
              matchedStroke = true;
              break;
            }
          }
        }

        if (!matchedStroke && item.note && item.note.trim()) {
          var sBadgePx = (14 / 1000) * contentRect.width;
          var sbx = contentRect.left + Math.min(contentRect.width - sBadgePx, maxX * contentRect.width - sBadgePx * 0.4);
          var sby = contentRect.top + Math.max(0, minY * contentRect.height - sBadgePx * 0.45);
          if (clientX >= sbx - 4 && clientX <= sbx + sBadgePx + 4 && clientY >= sby - 4 && clientY <= sby + sBadgePx + 4) {
            matchedStroke = true;
          }
        }
        if (matchedStroke) return { item: item };
      }
    }
    return null;
  }

  getHighlightAnchorRect(pageEl, item) {
    if (!pageEl || !pageEl.isConnected || !item) return null;
    var contentRect = getPageContentRect(pageEl);
    if (contentRect.width <= 0 || contentRect.height <= 0) return null;

    var minX = 1, minY = 1, maxX = 0, maxY = 0, found = false;
    if (item.rects && item.rects.length > 0) {
      for (var i = 0; i < item.rects.length; i++) {
        var r = item.rects[i];
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
        found = true;
      }
    } else if (item.points && item.points.length > 0) {
      for (var j = 0; j < item.points.length; j++) {
        minX = Math.min(minX, item.points[j][0]);
        maxX = Math.max(maxX, item.points[j][0]);
        minY = Math.min(minY, item.points[j][1]);
        maxY = Math.max(maxY, item.points[j][1]);
        found = true;
      }
    }
    if (!found) return null;

    var left = contentRect.left + minX * contentRect.width;
    var top = contentRect.top + minY * contentRect.height;
    var right = contentRect.left + maxX * contentRect.width;
    var bottom = contentRect.top + maxY * contentRect.height;
    var firstRight = item.rects && item.rects.length > 0 ? contentRect.left + (item.rects[0].x + item.rects[0].w) * contentRect.width : right;
    var firstTop = item.rects && item.rects.length > 0 ? contentRect.top + item.rects[0].y * contentRect.height : top;

    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: Math.max(8, right - left),
      height: Math.max(8, bottom - top),
      firstRight: firstRight,
      firstTop: firstTop
    };
  }

  updateHighlightHover(e) {
    var targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!targetEl) return;

    if (targetEl.closest(".drive-note-popover") || targetEl.closest(".drive-note-add-pill")) {
      window.clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
      return;
    }

    var isHighlightMode = !this.readingDeviceMode && (this.activeTool === "select" || this.activeTool === "highlighter");
    if (!isHighlightMode && this.activeTool !== "none" && !this.readingDeviceMode) return;

    var pageEl = targetEl.closest(".page[data-page-number]");
    var hit = null;
    var file = null;
    var pageNum = 0;

    if (pageEl) {
      var leaf = this.getLeafForElement(pageEl);
      file = this.getLeafFile(leaf);
      pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
      if (file && pageNum) {
        var contentRect = getPageContentRect(pageEl);
        hit = this.findHighlightAtPoint(file.path, pageNum, contentRect, e.clientX, e.clientY);
      }
    }

    if (hit && !isHighlightMode && !(hit.item.note && hit.item.note.trim())) hit = null;

    if (!hit) {
      this.hoveredHighlight = null;
      window.clearTimeout(this.hoverOpenTimer);
      if (!this.hoverCloseTimer) {
        this.hoverCloseTimer = window.setTimeout(() => {
          this.hoverCloseTimer = null;
          this.hideAddNotePill();
          if (this.notePopover && this.notePopover.mode === "preview") this.closeNotePopover(false);
        }, 180);
      }
      return;
    }

    window.clearTimeout(this.hoverCloseTimer);
    this.hoverCloseTimer = null;

    var item = hit.item;
    var normPath = normalizePath(file.path);
    var sameHovered =
      this.hoveredHighlight &&
      this.hoveredHighlight.item.id === item.id &&
      this.hoveredHighlight.pageNum === pageNum;

    if (!sameHovered) {
      this.hoveredHighlight = { filePath: normPath, pageNum: pageNum, item: item, pageEl: pageEl };
      window.clearTimeout(this.hoverOpenTimer);
      if (this.notePopover && this.notePopover.mode === "edit") return;

      if (item.note && item.note.trim()) {
        this.hideAddNotePill();
        this.hoverOpenTimer = window.setTimeout(() => {
          if (
            this.hoveredHighlight &&
            this.hoveredHighlight.item.id === item.id &&
            (!this.notePopover || this.notePopover.mode !== "edit")
          ) {
            this.openNotePopover("preview", normPath, pageNum, item, pageEl);
          }
        }, 120);
      } else if (isHighlightMode) {
        if (this.notePopover && this.notePopover.mode === "preview") this.closeNotePopover(false);
        this.hoverOpenTimer = window.setTimeout(() => {
          if (
            this.hoveredHighlight &&
            this.hoveredHighlight.item.id === item.id &&
            !this.readingDeviceMode &&
            (this.activeTool === "select" || this.activeTool === "highlighter") &&
            (!this.notePopover || this.notePopover.mode !== "edit")
          ) {
            this.showAddNotePill(normPath, pageNum, item, pageEl);
          }
        }, 160);
      }
    }
  }

  showAddNotePill(filePath, pageNum, item, pageEl) {
    if (this.readingDeviceMode || (this.activeTool !== "select" && this.activeTool !== "highlighter")) return;
    this.hideAddNotePill();
    var anchor = this.getHighlightAnchorRect(pageEl, item);
    if (!anchor) return;

    var pill = document.createElement("button");
    pill.type = "button";
    pill.className = "drive-note-add-pill";
    obsidian.setIcon(pill, "plus");
    var span = document.createElement("span");
    span.textContent = "Note";
    pill.appendChild(span);

    pill.onpointerenter = () => { window.clearTimeout(this.hoverCloseTimer); this.hoverCloseTimer = null; };
    pill.onpointerleave = () => {
      this.hoverCloseTimer = window.setTimeout(() => { this.hoverCloseTimer = null; this.hideAddNotePill(); }, 160);
    };
    pill.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); };
    pill.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideAddNotePill();
      this.openNotePopover("edit", filePath, pageNum, item, pageEl);
    };

    document.body.appendChild(pill);
    var pRect = pill.getBoundingClientRect();
    var left = Math.min(window.innerWidth - pRect.width - 10, Math.max(10, anchor.firstRight - pRect.width * 0.5));
    var top = anchor.firstTop - pRect.height - 6;
    if (top < 46) top = anchor.bottom + 6;
    pill.style.left = Math.round(left) + "px";
    pill.style.top = Math.round(top) + "px";
    this.addNotePillEl = pill;
  }

  hideAddNotePill() {
    if (this.addNotePillEl) {
      this.addNotePillEl.remove();
      this.addNotePillEl = null;
    }
  }

  openNotePopover(mode, filePath, pageNum, item, pageEl) {
    if (this.readingDeviceMode) {
      if (!item.note || !item.note.trim()) return;
      mode = "preview";
    }

    var normPath = normalizePath(filePath);
    if (!pageEl || !pageEl.isConnected) return;

    if (this.notePopover) {
      if (this.notePopover.mode === mode && this.notePopover.itemId === item.id && this.notePopover.filePath === normPath) {
        this.repositionNotePopover();
        return;
      }
      this.commitAndCloseNotePopover();
    }

    this.hideAddNotePill();

    var pop = document.createElement("div");
    pop.className = `drive-note-popover ${mode === "edit" ? "is-editing" : "is-preview"}`;

    var colorStrip = pop.createEl("div", { cls: "drive-note-color-strip" });
    colorStrip.style.backgroundColor = item.color || "#ffe066";

    pop.onpointerenter = () => { window.clearTimeout(this.hoverCloseTimer); this.hoverCloseTimer = null; };
    pop.onpointerleave = () => {
      if (this.notePopover && this.notePopover.mode === "preview") {
        this.hoverCloseTimer = window.setTimeout(() => {
          this.hoverCloseTimer = null;
          if (!this.hoveredHighlight || this.hoveredHighlight.item.id !== item.id) this.closeNotePopover(false);
        }, 180);
      }
    };
    pop.onpointerdown = (e) => e.stopPropagation();

    var textarea = null;

    if (mode === "preview") {
      var wrap = pop.createEl("div", { cls: "drive-note-preview-wrap" });
      var canEditInMode = !this.readingDeviceMode && (this.activeTool === "select" || this.activeTool === "highlighter");

      if (canEditInMode) {
        var hoverActions = wrap.createEl("div", { cls: "drive-note-preview-actions" });

        var editBtn = hoverActions.createEl("button", { cls: "drive-note-icon-btn" });
        editBtn.type = "button";
        obsidian.setIcon(editBtn, "pencil");
        editBtn.setAttribute("aria-label", "Edit note");
        editBtn.onclick = (e) => { e.stopPropagation(); this.openNotePopover("edit", normPath, pageNum, item, pageEl); };

        var delNoteBtn = hoverActions.createEl("button", { cls: "drive-note-icon-btn is-danger" });
        delNoteBtn.type = "button";
        obsidian.setIcon(delNoteBtn, "trash-2");
        delNoteBtn.setAttribute("aria-label", "Remove note");
        delNoteBtn.onclick = (e) => { e.stopPropagation(); this.saveHighlightNote(normPath, item, ""); this.closeNotePopover(false); };
      }

      var body = wrap.createEl("div", { cls: `drive-note-preview-body ${canEditInMode ? "is-clickable" : ""}` });
      body.textContent = item.note || "";
      if (canEditInMode) {
        body.onclick = (e) => { e.stopPropagation(); this.openNotePopover("edit", normPath, pageNum, item, pageEl); };
      }
    } else {
      var editWrap = pop.createEl("div", { cls: "drive-note-editor-wrap" });
      var topRow = editWrap.createEl("div", { cls: "drive-note-editor-top" });
      var colorRow = topRow.createEl("div", { cls: "drive-note-color-row" });

      (this.settings.colors || []).forEach((c) => {
        var dotBtn = colorRow.createEl("button", {
          cls: `drive-note-color-dot ${item.color === c.color ? "is-active" : ""}`
        });
        dotBtn.type = "button";
        dotBtn.style.backgroundColor = c.color;
        dotBtn.setAttribute("aria-label", c.name || c.color);
        dotBtn.onclick = (e) => {
          e.stopPropagation();
          this.changeHighlightColor(normPath, item, c.color);
          colorStrip.style.backgroundColor = c.color;
          colorRow.querySelectorAll(".drive-note-color-dot").forEach((d) => {
            if (d === dotBtn) d.addClass("is-active");
            else d.removeClass("is-active");
          });
        };
      });

      var rightActions = topRow.createEl("div", { cls: "drive-note-actions" });

      var deleteHlBtn = rightActions.createEl("button", { cls: "drive-note-icon-btn is-danger" });
      deleteHlBtn.type = "button";
      obsidian.setIcon(deleteHlBtn, "trash-2");
      deleteHlBtn.setAttribute("aria-label", "Delete highlight");
      deleteHlBtn.onclick = (e) => { e.stopPropagation(); this.closeNotePopover(false); this.deleteHighlightItem(normPath, item); };

      var closeBtn = rightActions.createEl("button", { cls: "drive-note-icon-btn" });
      closeBtn.type = "button";
      obsidian.setIcon(closeBtn, "x");
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.onclick = (e) => { e.stopPropagation(); this.commitAndCloseNotePopover(); };

      textarea = editWrap.createEl("textarea", { cls: "drive-note-textarea" });
      textarea.placeholder = "Add a note...";
      textarea.value = item.note || "";

      var autoResize = () => {
        textarea.style.height = "auto";
        textarea.style.height = Math.min(200, Math.max(54, textarea.scrollHeight)) + "px";
      };

      textarea.addEventListener("input", () => { autoResize(); this.repositionNotePopover(); });
      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
          e.preventDefault();
          e.stopPropagation();
          this.commitAndCloseNotePopover();
        }
      });

      var footer = editWrap.createEl("div", { cls: "drive-note-editor-footer" });
      var btnGroup = footer.createEl("div", { cls: "drive-note-btn-group" });
      if (item.note && item.note.trim()) {
        var clearBtn = btnGroup.createEl("button", { cls: "drive-note-btn", text: "Clear" });
        clearBtn.type = "button";
        clearBtn.onclick = (e) => { e.stopPropagation(); textarea.value = ""; this.commitAndCloseNotePopover(); };
      }

      var saveBtn = btnGroup.createEl("button", { cls: "drive-note-btn is-primary", text: "Save" });
      saveBtn.type = "button";
      saveBtn.onclick = (e) => { e.stopPropagation(); this.commitAndCloseNotePopover(); };

      window.setTimeout(() => {
        if (textarea && textarea.isConnected) {
          autoResize();
          textarea.focus();
          var len = textarea.value.length;
          textarea.setSelectionRange(len, len);
          this.repositionNotePopover();
        }
      }, 0);
    }

    document.body.appendChild(pop);

    this.notePopover = {
      mode: mode,
      filePath: normPath,
      pageNum: pageNum,
      item: item,
      itemId: item.id,
      pageEl: pageEl,
      el: pop,
      textarea: textarea
    };

    this.repositionNotePopover();
  }

  repositionNotePopover() {
    if (!this.notePopover || !this.notePopover.el) return;
    var { pageEl, item, el } = this.notePopover;
    if (!pageEl || !pageEl.isConnected) {
      if (this.notePopover.mode === "edit") this.commitAndCloseNotePopover();
      else this.closeNotePopover(false);
      return;
    }

    var anchor = this.getHighlightAnchorRect(pageEl, item);
    if (!anchor) return;

    var popRect = el.getBoundingClientRect();
    var popW = popRect.width || 256;
    var popH = popRect.height || 100;

    var container = pageEl.closest(".pdf-viewer-container, .pdf-container");
    var bounds = container
      ? container.getBoundingClientRect()
      : { left: 8, top: 44, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };

    var minLeft = Math.max(8, bounds.left + 8);
    var maxLeft = Math.min(window.innerWidth - popW - 8, bounds.right - popW - 8);
    var desiredLeft = anchor.left + anchor.width / 2 - popW / 2;
    var left = Math.max(minLeft, Math.min(maxLeft, desiredLeft));

    var minTop = Math.max(8, bounds.top + 8);
    var top = anchor.top - popH - 8;
    if (top < minTop) top = anchor.bottom + 8;
    if (top + popH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - popH - 8);

    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  commitAndCloseNotePopover() {
    if (!this.notePopover) return;
    var popState = this.notePopover;
    if (!this.readingDeviceMode && popState.mode === "edit" && popState.textarea) {
      this.saveHighlightNote(popState.filePath, popState.item, popState.textarea.value);
    }
    this.closeNotePopover(false);
  }

  closeNotePopover(saveChanges) {
    if (!this.notePopover) return;
    if (saveChanges) { this.commitAndCloseNotePopover(); return; }
    if (this.notePopover.el) this.notePopover.el.remove();
    this.notePopover = null;
  }

  saveHighlightNote(filePath, item, rawNoteText) {
    if (this.readingDeviceMode) return;
    var normPath = normalizePath(filePath);
    var nextText = (rawNoteText || "").trim();
    var prevText = (item.note || "").trim();
    if (nextText === prevText) return;

    var now = this.nowTs();
    this.pushHistory(normPath);
    item.note = nextText;
    item.noteUpdatedAt = now;
    item.updatedAt = now;
    this.renderDataVersion++;
    this.scheduleAllPdfRender(true);
    this.saveAnnotationsNow();
  }

  changeHighlightColor(filePath, item, color) {
    if (this.readingDeviceMode || !color || item.color === color) return;
    var normPath = normalizePath(filePath);
    var now = this.nowTs();
    this.pushHistory(normPath);
    item.color = color;
    item.colorUpdatedAt = now;
    item.updatedAt = now;
    this.renderDataVersion++;
    this.scheduleAllPdfRender(true);
    this.saveAnnotationsNow();
  }

  deleteHighlightItem(filePath, item) {
    if (this.readingDeviceMode) return;
    var normPath = normalizePath(filePath);
    var items = this.pdfHighlights[normPath] || [];
    if (!items.length) return;

    this.pushHistory(normPath);
    this.deletedIds[item.id] = this.nowTs();
    this.sessionErasedIds.add(item.id);
    this.pdfHighlights[normPath] = items.filter((a) => a.id !== item.id);
    this.hasExplicitUserDeletion = true;

    this.hoveredHighlight = null;
    this.hideAddNotePill();
    this.renderDataVersion++;
    this.scheduleAllPdfRender(true);
    this.saveAnnotationsNow();
  }

  // --- ZERO-DRIFT OVERLAY & RENDER PIPELINE ---
  scheduleAllPdfRender(force) {
    if (force) this._forceNextRender = true;
    if (this.renderRafId) return;
    this.renderRafId = window.requestAnimationFrame(() => {
      this.renderRafId = null;
      var shouldForce = !!this._forceNextRender;
      this._forceNextRender = false;
      this.renderAllPdfViews(shouldForce);
    });
  }

  scheduleLeafRender(binding, force) {
    if (!binding) return;
    if (force) binding._forceNextRender = true;
    if (binding.renderTimer) return;
    binding.renderTimer = window.setTimeout(() => {
      binding.renderTimer = null;
      var shouldForce = !!binding._forceNextRender;
      binding._forceNextRender = false;
      if (this.viewBindings.has(binding.view)) this.renderLeafViews(binding, shouldForce);
    }, 16);
  }

  renderAllPdfViews(force) {
    for (var binding of this.viewBindings.values()) {
      this.renderLeafViews(binding, force);
    }
  }

  renderLeafViews(binding, force) {
    if (!binding || !binding.leaf || binding.leaf.isDeferred) return;
    var file = this.getLeafFile(binding.leaf);
    if (!file || file.extension !== "pdf") return;

    var container = binding.containerEl;
    if (!container || !container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;

    var normPath = normalizePath(file.path);
    binding.filePath = normPath;

    var viewRect = container.getBoundingClientRect();
    var pages = container.querySelectorAll(".page[data-page-number]");
    for (var i = 0; i < pages.length; i++) {
      var pageEl = pages[i];
      if (pageEl.clientWidth === 0 || pageEl.clientHeight === 0) continue;

      var pr = pageEl.getBoundingClientRect();
      var nearViewport = pr.bottom >= viewRect.top - 900 && pr.top <= viewRect.bottom + 900;
      var hasCanvas = !!pageEl.querySelector(":scope > .canvasWrapper, :scope > .textLayer");
      var hasOverlay = !!pageEl.querySelector(":scope > .drive-pdf-page-overlay");

      if (nearViewport || hasCanvas || hasOverlay) {
        this.renderSinglePageByElement(binding, pageEl, force);
      }
    }
  }

  renderSinglePageByElement(binding, pageEl, force) {
    var file = this.getLeafFile(binding.leaf);
    if (!file || file.extension !== "pdf") return;
    if (!pageEl || !pageEl.isConnected || pageEl.clientWidth === 0 || pageEl.clientHeight === 0) return;

    var pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
    if (!pageNum) return;

    var normPath = normalizePath(file.path);
    var items = this.pdfHighlights[normPath] || [];
    var pageItems = items.filter((a) => a.page === pageNum);

    var existingHost = pageEl.querySelector(":scope > .drive-pdf-page-overlay");
    if (pageItems.length === 0 && !existingHost && !this.isDrawing) return;

    var contentRect = getPageContentRect(pageEl);
    if (contentRect.width <= 0 || contentRect.height <= 0) return;

    var layers = this.ensureLayersAttached(pageEl);
    var host = layers.host;
    var viewHeight = layers.viewHeight || 1000;

    var prevState = host._hlRenderedState;
    var aspectDiff = prevState ? Math.abs((prevState.viewHeight || 0) - viewHeight) : 999;

    if (
      !force &&
      prevState &&
      prevState.version === this.renderDataVersion &&
      prevState.filePath === normPath &&
      prevState.pageNum === pageNum &&
      prevState.textMode === (!this.readingDeviceMode && this.activeTool === "text") &&
      aspectDiff <= 0.5
    ) {
      return;
    }

    this.suppressMutationDepth++;
    try {
      layers.highlightGroup.empty();
      layers.penGroup.empty();
      layers.metaGroup.empty();

      var activeBoxId = this.activeEditingBox ? this.activeEditingBox.getAttribute("data-id") : null;
      var renderedBoxIds = new Set();

      pageItems.forEach((item) => {
        if (item.type === "text") {
          renderedBoxIds.add(item.id);
          if (item.id === activeBoxId) {
            var activeDom = layers.textLayer.querySelector(`.drive-text-box[data-id="${item.id}"]`);
            if (activeDom) this.applyBoxStyle(activeDom, item);
          } else {
            this.renderSingleTextBox(layers.textLayer, item, normPath);
          }
          return;
        }

        if (item.rects && item.rects.length > 0) {
          this.renderRectHighlight(layers, item, viewHeight);
          return;
        }

        if (item.type === "ink" && item.points) {
          var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", item.color);
          path.setAttribute("stroke-width", String(item.width || 2.5));
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("stroke-linejoin", "round");

          var pts = item.points;
          var d = "";
          var maxX = 0;
          var minY = 1;
          if (pts.length === 1) {
            d = `M ${(pts[0][0] * 1000).toFixed(1)} ${(pts[0][1] * viewHeight).toFixed(1)} L ${(pts[0][0] * 1000).toFixed(1)} ${(pts[0][1] * viewHeight).toFixed(1)}`;
            maxX = pts[0][0];
            minY = pts[0][1];
          } else {
            for (var pIdx = 0; pIdx < pts.length; pIdx++) {
              var p = pts[pIdx];
              d += (pIdx === 0 ? "M " : " L ") + (p[0] * 1000).toFixed(1) + " " + (p[1] * viewHeight).toFixed(1);
              maxX = Math.max(maxX, p[0]);
              minY = Math.min(minY, p[1]);
            }
          }
          path.setAttribute("d", d);

          if (item.isHighlighter) {
            layers.highlightGroup.appendChild(path);
            if (item.note && item.note.trim()) {
              this.renderNoteCornerBadge(layers.metaGroup, maxX * 1000, minY * viewHeight, item.color, viewHeight);
            }
          } else {
            layers.penGroup.appendChild(path);
          }
        }
      });

      layers.textLayer.querySelectorAll(".drive-text-box").forEach((b) => {
        var bId = b.getAttribute("data-id");
        if (!renderedBoxIds.has(bId) && bId !== activeBoxId) b.remove();
      });

      host._hlRenderedState = {
        version: this.renderDataVersion,
        filePath: normPath,
        pageNum: pageNum,
        textMode: !this.readingDeviceMode && this.activeTool === "text",
        viewHeight: viewHeight
      };
    } finally {
      this.suppressMutationDepth--;
    }
  }

  renderRectHighlight(layers, item, viewHeight) {
    var hasNote = !!(item.note && item.note.trim());
    var accent = hasNote ? getNoteAccentColor(item.color) : null;

    for (var rIdx = 0; rIdx < item.rects.length; rIdx++) {
      var nr = item.rects[rIdx];
      var rx = nr.x * 1000;
      var ry = nr.y * viewHeight;
      var rw = nr.w * 1000;
      var rh = nr.h * viewHeight;

      var rectEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rectEl.setAttribute("x", rx.toFixed(1));
      rectEl.setAttribute("y", ry.toFixed(1));
      rectEl.setAttribute("width", rw.toFixed(1));
      rectEl.setAttribute("height", rh.toFixed(1));
      rectEl.setAttribute("rx", "1.5");
      rectEl.setAttribute("fill", item.color);
      layers.highlightGroup.appendChild(rectEl);

      if (hasNote) {
        var lineEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        lineEl.setAttribute("x", rx.toFixed(1));
        lineEl.setAttribute("y", Math.max(0, ry + rh - 1.6).toFixed(1));
        lineEl.setAttribute("width", rw.toFixed(1));
        lineEl.setAttribute("height", "2.0");
        lineEl.setAttribute("rx", "1");
        lineEl.setAttribute("fill", accent);
        lineEl.setAttribute("opacity", "0.85");
        layers.metaGroup.appendChild(lineEl);
      }
    }

    if (hasNote && item.rects.length > 0) {
      var first = item.rects[0];
      this.renderNoteCornerBadge(layers.metaGroup, (first.x + first.w) * 1000, first.y * viewHeight, item.color, viewHeight);
    }
  }

  renderNoteCornerBadge(metaGroup, rightX, topY, color, viewHeight) {
    var badgeSize = 11.5;
    var bx = Math.max(1, Math.min(1000 - badgeSize - 1, rightX - badgeSize * 0.42));
    var by = Math.max(1, Math.min(viewHeight - badgeSize - 1, topY - badgeSize * 0.42));
    var accent = getNoteAccentColor(color);

    var badge = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    badge.setAttribute("x", bx.toFixed(1));
    badge.setAttribute("y", by.toFixed(1));
    badge.setAttribute("width", String(badgeSize));
    badge.setAttribute("height", String(badgeSize));
    badge.setAttribute("rx", "2.8");
    badge.setAttribute("fill", accent);
    badge.setAttribute("stroke", "#ffffff");
    badge.setAttribute("stroke-width", "0.9");
    badge.setAttribute("opacity", "0.95");
    metaGroup.appendChild(badge);

    var lines = document.createElementNS("http://www.w3.org/2000/svg", "path");
    lines.setAttribute(
      "d",
      `M ${(bx + 3).toFixed(1)} ${(by + 4.2).toFixed(1)} h 5.5 M ${(bx + 3).toFixed(1)} ${(by + 7.2).toFixed(1)} h 3.8`
    );
    lines.setAttribute("stroke", "#ffffff");
    lines.setAttribute("stroke-width", "1.15");
    lines.setAttribute("stroke-linecap", "round");
    metaGroup.appendChild(lines);
  }

  syncPageOverlayGeometry(pageEl, knownRect) {
    if (!pageEl) return 1000;
    var host = pageEl.querySelector(":scope > .drive-pdf-page-overlay");
    var rect = knownRect || getPageContentRect(pageEl);
    if (!rect || rect.width <= 0 || rect.height <= 0) return 1000;

    var viewHeight = (rect.height / rect.width) * 1000;
    if (!isFinite(viewHeight) || viewHeight <= 0) viewHeight = 1000;

    if (host) {
      var cw = pageEl.querySelector(":scope > .canvasWrapper");
      if (cw && cw.offsetWidth > 0 && cw.offsetHeight > 0 && (cw.offsetLeft !== 0 || cw.offsetTop !== 0)) {
        host.style.left = cw.offsetLeft + "px";
        host.style.top = cw.offsetTop + "px";
        host.style.width = cw.offsetWidth + "px";
        host.style.height = cw.offsetHeight + "px";
      } else {
        host.style.left = "0";
        host.style.top = "0";
        host.style.width = "100%";
        host.style.height = "100%";
      }

      host.style.setProperty("--hl-unit", (rect.width / 1000).toFixed(6) + "px");

      var svg = host.querySelector(".drive-annotation-layer");
      if (svg) {
        var nextVb = `0 0 1000 ${viewHeight.toFixed(2)}`;
        if (svg.getAttribute("viewBox") !== nextVb) svg.setAttribute("viewBox", nextVb);
        svg._hlViewHeight = viewHeight;
      }
    }
    return viewHeight;
  }

  ensureLayersAttached(pageEl) {
    var host = pageEl.querySelector(":scope > .drive-pdf-page-overlay");
    if (!host) {
      this.suppressMutationDepth++;
      try {
        host = document.createElement("div");
        host.className = "drive-pdf-page-overlay";

        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "drive-annotation-layer");
        svg.setAttribute("viewBox", "0 0 1000 1000");
        svg.setAttribute("preserveAspectRatio", "none");

        var highlightGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        highlightGroup.setAttribute("class", "drive-highlight-group");
        highlightGroup.style.mixBlendMode = "multiply";
        highlightGroup.setAttribute("opacity", "0.38");
        svg.appendChild(highlightGroup);

        var penGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        penGroup.setAttribute("class", "drive-pen-group");
        svg.appendChild(penGroup);

        var metaGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        metaGroup.setAttribute("class", "drive-highlight-meta-group");
        svg.appendChild(metaGroup);

        var textLayer = document.createElement("div");
        textLayer.className = "drive-text-annotation-layer";

        host.appendChild(svg);
        host.appendChild(textLayer);
        pageEl.appendChild(host);
      } finally {
        this.suppressMutationDepth--;
      }
    }

    var viewHeight = this.syncPageOverlayGeometry(pageEl);
    return {
      host: host,
      svg: host.querySelector(".drive-annotation-layer"),
      highlightGroup: host.querySelector(".drive-highlight-group"),
      penGroup: host.querySelector(".drive-pen-group"),
      metaGroup: host.querySelector(".drive-highlight-meta-group"),
      textLayer: host.querySelector(".drive-text-annotation-layer"),
      viewHeight: viewHeight
    };
  }

  async loadSettings() {
    var data = null;
    try {
      data = await this.loadData();
    } catch (e) {
      console.warn("[Highlighter] Failed to read data.json:", e);
    }

    this.settings = {
      fontFamily: data?.fontFamily || DEFAULT_SETTINGS.fontFamily,
      colors: Array.isArray(data?.colors) && data.colors.length
        ? data.colors.map((c, idx) =>
            typeof c === "string"
              ? { name: `Color ${idx + 1}`, color: c }
              : { name: c?.name || `Color ${idx + 1}`, color: c?.color || "#ffe066" }
          )
        : DEFAULT_SETTINGS.colors.map((c) => ({ ...c })),
      hotkeys: Object.assign({}, DEFAULT_SETTINGS.hotkeys, data?.hotkeys || {}),
      textFormatting: Object.assign({}, DEFAULT_SETTINGS.textFormatting, data?.textFormatting || {})
    };

    var hasBlack = this.settings.colors.some(
      (c) =>
        (c?.name && typeof c.name === "string" && c.name.toLowerCase() === "black") ||
        c?.color === "#000000" ||
        c?.color === "#111111"
    );
    if (!hasBlack) this.settings.colors.unshift({ name: "Black", color: "#111111" });
  }

  async saveSettingsOnly() {
    try {
      await this.saveData({
        fontFamily: this.settings.fontFamily,
        colors: this.settings.colors,
        hotkeys: this.settings.hotkeys,
        textFormatting: this.settings.textFormatting
      });
    } catch (err) {
      console.error("[Highlighter] Failed to save settings:", err);
    }
  }
}

HighlighterPlugin.default = HighlighterPlugin;
module.exports = HighlighterPlugin;
module.exports.default = HighlighterPlugin;
module.exports.__esModule = true;