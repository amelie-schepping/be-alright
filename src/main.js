import "./styles.scss";
import "bootstrap";

/* ===========================
   Navbar: Active Link + Farbe
   =========================== */
const navbar = document.querySelector(".navbar");
const sections = document.querySelectorAll(".page-section");
const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

const findLink = (id) =>
  [...navLinks].find((a) => a.getAttribute("href") === `#${id}`);

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      // Aktiven Link setzen
      navLinks.forEach((link) => link.classList.remove("active"));
      const link = findLink(entry.target.id);
      if (link) link.classList.add("active");

      // Navbar-Farbe
      const id = entry.target.id;
      if (id === "loop-station") {
        navbar.classList.add("text-light");
      } else {
        navbar.classList.remove("text-light");
      }
    });
  },
  { threshold: 0.6 }
);

sections.forEach((section) => observer.observe(section));

/* ===========================
   Loop Station (Web Audio API, Crossfades)
   =========================== */
const tracks = [
  { id: "piano", url: "/be-alright/audio/piano.wav" },
  { id: "pads", url: "/be-alright/audio/pads.wav" },
  { id: "eguitar", url: "/be-alright/audio/eguitar.wav" },
  { id: "birds", url: "/be-alright/audio/birds.wav" },
  { id: "guitar", url: "/be-alright/audio/guitar.wav" },
];

let ctx = null;

// Per-Track State
// id -> { buffer, masterGain, nextStart, loopDur, fade, schedulerActive, voices:Set<AudioBufferSourceNode> }
const state = new Map();

// Merkt sich Slider-Startwerte (für Reset) und letztes gewünschtes Level (0..1) je Track
const initialLevel = new Map();
const lastLevel = new Map();

// Slider-Elemente cachen
const sliders = new Map();
document.querySelectorAll(".loop-vol[data-track]").forEach((sl) => {
  const id = sl.dataset.track;
  const level = Number(sl.value) / 100;
  const safe = Number.isFinite(level) ? level : 1;
  initialLevel.set(id, safe);
  lastLevel.set(id, safe);
  sliders.set(id, sl);
});

/* =========
   Init / Load
   ========= */
async function ensureContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}

async function loadBuffersOnce() {
  await ensureContext();
  // Schon geladen?
  if (tracks.every((t) => state.has(t.id))) return;

  for (const t of tracks) {
    const res = await fetch(t.url);
    const arr = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arr);

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.0; // Start: stumm
    masterGain.connect(ctx.destination);

    // Crossfade
    const fade = Math.min(0.03, buffer.duration * 0.1);

    state.set(t.id, {
      buffer,
      masterGain,
      nextStart: 0,
      loopDur: buffer.duration,
      fade,
      schedulerActive: false,
      voices: new Set(),
    });
  }
}

/* =========
   Scheduling
   ========= */
function scheduleOneVoice(track, startTime) {
  const s = state.get(track.id);
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;

  const voice = ctx.createGain();
  voice.gain.value = 0;

  src.connect(voice).connect(s.masterGain);

  const { fade, loopDur } = s;
  const endTime = startTime + loopDur;

  // Crossfade-Hüllkurve
  voice.gain.setValueAtTime(0, startTime);
  voice.gain.linearRampToValueAtTime(1, startTime + fade); // Fade-In
  voice.gain.setValueAtTime(1, endTime - fade);
  voice.gain.linearRampToValueAtTime(0, endTime); // Fade-Out

  // Track aktive Quelle (für harten Reset)
  s.voices.add(src);

  src.start(startTime);
  src.stop(endTime + 0.002);

  src.onended = () => {
    try {
      src.disconnect();
      voice.disconnect();
    } catch {}
    s.voices.delete(src);
  };

  return { endTime };
}

function startScheduling(track, startAt) {
  const s = state.get(track.id);
  if (!s || s.schedulerActive) return;
  s.schedulerActive = true;

  const TICK_SAFE_MARGIN = 0.05; // Sekunden

  const scheduleNext = (t0) => {
    scheduleOneVoice(track, t0);

    const nextT = t0 + s.loopDur;
    s.nextStart = nextT;

    const delayMs = Math.max(0, (s.loopDur - s.fade - TICK_SAFE_MARGIN) * 1000);
    setTimeout(() => {
      if (!s.schedulerActive) return;
      if (ctx.state !== "running") {
        const resumeWatcher = setInterval(() => {
          if (ctx.state === "running") {
            clearInterval(resumeWatcher);
            scheduleNext(nextT);
          }
        }, 20);
      } else {
        scheduleNext(nextT);
      }
    }, delayMs);
  };

  scheduleNext(startAt);
}

function stopScheduling(trackId) {
  const s = state.get(trackId);
  if (!s) return;
  s.schedulerActive = false;
  // Alle aktuell laufenden/angestarteten Quellen hart beenden
  s.voices.forEach((src) => {
    try {
      src.stop(0);
    } catch {}
  });
  s.voices.clear();
}

/* =========
   Start-Strategien
   ========= */
async function startAllSchedulersAligned(startAt) {
  await loadBuffersOnce();
  for (const t of tracks) {
    const s = state.get(t.id);
    s.nextStart = startAt;
    if (!s.schedulerActive) startScheduling(t, startAt);
  }
}

/**
 * Startet alle Loops synchron.
 * - Wenn noch nie gestartet: alle Scheduler anwerfen (stumm), der Klickende wird hörbar.
 * - Wenn bereits gestartet: nichts neu starten (behalten Sync).
 */
async function startAllIfNeeded() {
  await loadBuffersOnce();
  const anyActive = tracks.some((t) => state.get(t.id)?.schedulerActive);
  if (anyActive) return;

  const when = ctx.currentTime + 0.1;
  await startAllSchedulersAligned(when);
}

/**
 * Reset: Stoppt alle aktuell geplanten Quellen, richtet alle Loops neu aus
 * und setzt Slider zurück.
 */
async function resetAll({
  muteAll = true,
  resetSlidersToInitial = false,
} = {}) {
  await loadBuffersOnce();

  // 1) Scheduling komplett stoppen
  for (const t of tracks) stopScheduling(t.id);

  // 2) Gains ggf. muten
  if (muteAll) {
    for (const t of tracks) {
      const s = state.get(t.id);
      s.masterGain.gain.setValueAtTime(0, ctx.currentTime);
      updateButtonUI(t.id, false);
    }
  }

  // 3) Slider zurücksetzen (Anfangswerte)
  if (resetSlidersToInitial) {
    for (const t of tracks) {
      const init = initialLevel.get(t.id) ?? 1;
      lastLevel.set(t.id, init);
      const sl = sliders.get(t.id);
      if (sl) sl.value = Math.round(init * 100);
    }
  }

  // 4) Neu & synchron anwerfen (stumm, wenn gemutet)
  const startAt = ctx.currentTime + 0.12;
  await startAllSchedulersAligned(startAt);
}

/* =========
   UI-Helpers
   ========= */
function updateButtonUI(id, isOn) {
  const btn = document.querySelector(`.loop-btn[data-track="${id}"]`);
  if (!btn) return;
  btn.classList.toggle("btn-dark", isOn);
  btn.classList.toggle("btn-outline-dark", !isOn);
}

/* ===========================
   Toggle + Slider-Logik
   =========================== */

// Button: zwischen 0 und letztem Slider-Level toggeln
async function toggleTrack(id) {
  await ensureContext();
  await startAllIfNeeded();

  const s = state.get(id);
  if (!s) return;
  const g = s.masterGain.gain;
  const isOn = g.value > 0.001;
  const target = isOn ? 0.0 : lastLevel.get(id) ?? 1.0;

  g.setTargetAtTime(target, ctx.currentTime, 0.01);
  updateButtonUI(id, target > 0.001);
}

// Slider: setzt Pegel direkt (startet Audio bei Bedarf)
document.querySelectorAll(".loop-vol[data-track]").forEach((sl) => {
  sl.addEventListener("input", async () => {
    const id = sl.dataset.track;
    const level = Number(sl.value) / 100;
    lastLevel.set(id, level);

    await ensureContext();
    await startAllIfNeeded();

    const s = state.get(id);
    if (!s) return;
    s.masterGain.gain.setTargetAtTime(level, ctx.currentTime, 0.01);
    updateButtonUI(id, level > 0.001);
  });
});

// Buttons: Instrumente
document.querySelectorAll(".loop-btn[data-track]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await toggleTrack(btn.dataset.track);
  });
});

// All Mute / Reset
document.getElementById("all-off")?.addEventListener("click", async () => {
  await ensureContext();
  await resetAll({ muteAll: true, resetSlidersToInitial: true });
});

// Master-Play/Pause
document
  .getElementById("master-toggle")
  ?.addEventListener("click", async () => {
    await ensureContext();

    // einmalig Listener setzen
    if (!ctx._stateListenerBound) {
      ctx.onstatechange = refreshMasterIcon;
      ctx._stateListenerBound = true;
    }

    const anyActive = tracks.some((t) => state.get(t.id)?.schedulerActive);

    if (!anyActive) {
      // === ERSTER MASTER-KLICK: alles vorbereiten & FORCE-PLAY ===
      await loadBuffersOnce();

      // Gains gemäß den (gemerkten) Slider-Werten setzen
      for (const t of tracks) {
        // Fallback: wenn kein lastLevel existiert, nimm initialLevel oder 1.0
        const lvl =
          (lastLevel.has(t.id)
            ? lastLevel.get(t.id)
            : initialLevel.get(t.id)) ?? 1.0;

        state.get(t.id).masterGain.gain.setValueAtTime(lvl, ctx.currentTime);
        updateButtonUI(t.id, lvl > 0.001);
      }

      // synchron starten
      const startAt = ctx.currentTime + 0.12;
      await startAllSchedulersAligned(startAt);

      // WICHTIG: nicht togglen, sondern sicherstellen, dass gespielt wird
      if (ctx.state !== "running") await ctx.resume();

      refreshMasterIcon();
      return; // <-- keine Toggle-Logik beim ersten Klick
    }

    // === NACHFOLGENDE KLICKS: normales Toggle ===
    if (ctx.state === "running") {
      await ctx.suspend();
    } else {
      await ctx.resume();
    }
    refreshMasterIcon();
  });

// === Master-Button Icon steuern ===
const masterBtn = document.getElementById("master-toggle");
const masterIcon = masterBtn?.querySelector("i");

function refreshMasterIcon() {
  if (!masterIcon) return;
  const running = ctx && ctx.state === "running";

  masterIcon.classList.remove("bi-play-fill", "bi-play-pause");
  masterIcon.classList.add(running ? "bi-play-pause" : "bi-play-fill");

  // Bonus: A11y / Tooltip
  masterBtn?.setAttribute("aria-label", running ? "Pause all" : "Play all");
  masterBtn?.setAttribute("title", running ? "Pause" : "Play");
}

// Beim ersten Laden: Play zeigen
refreshMasterIcon();

/* ===========================
   Sidebar Toggle + Click-Outside
   =========================== */
const sidebarEl = document.getElementById("loop-sidebar");
const toggleEl = document.getElementById("sidebar-toggle");
const backdropEl = document.getElementById("sidebar-backdrop");

function openSidebar() {
  sidebarEl?.classList.add("active");
  backdropEl?.classList.add("show");
  toggleEl?.classList.add("open");
  toggleEl?.setAttribute("aria-expanded", "true");
  sidebarEl?.setAttribute("aria-hidden", "false");
}

function closeSidebar() {
  sidebarEl?.classList.remove("active");
  backdropEl?.classList.remove("show");
  toggleEl?.classList.remove("open");
  toggleEl?.setAttribute("aria-expanded", "false");
  sidebarEl?.setAttribute("aria-hidden", "true");
}

function toggleSidebar() {
  if (!sidebarEl) return;
  if (sidebarEl.classList.contains("active")) closeSidebar();
  else openSidebar();
}

toggleEl?.addEventListener("click", toggleSidebar);
backdropEl?.addEventListener("click", closeSidebar);

// ESC zum Schließen
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebarEl?.classList.contains("active")) {
    closeSidebar();
  }
});
