import "./styles.scss";
import "bootstrap";

/* ===========================
   Navbar: Active Link + Transparenz
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

      // Navbar-Transparenz
      const id = entry.target.id;
      if (id === "about" || id === "loop-station") {
        navbar.classList.add("transparent");
      } else {
        navbar.classList.remove("transparent");
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
  { id: "pad", url: "/be-alright/audio/pad.wav" },
];

let ctx = null;

// Per-Track State
// id -> { buffer, masterGain, nextStart, loopDur, fade, schedulerActive }
const state = new Map();

// Merkt sich das zuletzt gewünschte Level je Track (0..1) für Button-Toggle
const lastLevel = new Map();

// Initialwerte aus Slidern lesen (falls vorhanden)
document.querySelectorAll(".loop-vol[data-track]").forEach((sl) => {
  const id = sl.dataset.track;
  const level = Number(sl.value) / 100;
  lastLevel.set(id, isFinite(level) ? level : 1);
});

async function loadBuffersOnce() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  for (const t of tracks) {
    const res = await fetch(t.url);
    const arr = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arr);

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.0; // Start: stumm
    masterGain.connect(ctx.destination);

    // Crossfade-Länge (Sekunden): 15–50 ms unauffällig
    const fade = Math.min(0.03, buffer.duration * 0.1);

    state.set(t.id, {
      buffer,
      masterGain,
      nextStart: 0,
      loopDur: buffer.duration,
      fade,
      schedulerActive: false,
    });
  }
}

function scheduleOneVoice(track, startTime) {
  const s = state.get(track.id);
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;

  const voice = ctx.createGain();
  voice.gain.value = 0;

  src.connect(voice).connect(s.masterGain);

  const { fade, loopDur } = s;
  const endTime = startTime + loopDur;

  // Crossfade-Hüllkurve (linear reicht hier gut)
  voice.gain.setValueAtTime(0, startTime);
  voice.gain.linearRampToValueAtTime(1, startTime + fade); // Fade-In
  voice.gain.setValueAtTime(1, endTime - fade);
  voice.gain.linearRampToValueAtTime(0, endTime); // Fade-Out

  src.start(startTime);
  src.stop(endTime + 0.001);

  src.onended = () => {
    try {
      src.disconnect();
      voice.disconnect();
    } catch {}
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

async function startAllIfNeeded() {
  await loadBuffersOnce();
  if (ctx.state === "suspended") await ctx.resume();

  const when = ctx.currentTime + 0.1; // gemeinsamer Start
  for (const t of tracks) {
    const s = state.get(t.id);
    if (!s) continue;
    if (!s.schedulerActive) {
      s.nextStart = when;
      startScheduling(t, when);
    }
  }
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
function toggleTrack(id) {
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

    await startAllIfNeeded();
    if (ctx.state === "suspended") await ctx.resume();

    const s = state.get(id);
    if (!s) return;
    s.masterGain.gain.setTargetAtTime(level, ctx.currentTime, 0.01);
    updateButtonUI(id, level > 0.001);
  });
});

// Buttons
document.querySelectorAll(".loop-btn[data-track]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await startAllIfNeeded();
    if (ctx.state === "suspended") await ctx.resume();
    toggleTrack(btn.dataset.track);
  });
});

// All Mute
document.getElementById("all-off")?.addEventListener("click", async () => {
  await loadBuffersOnce();
  state.forEach((s, id) => {
    s.masterGain.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
    updateButtonUI(id, false);
  });
});

// Master Play/Pause (ganzer Context)
document
  .getElementById("master-toggle")
  ?.addEventListener("click", async () => {
    await loadBuffersOnce();
    if (ctx.state === "running") await ctx.suspend();
    else await ctx.resume();
  });
