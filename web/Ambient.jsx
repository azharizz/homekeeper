import React, { useCallback } from "react";

// Ripples are queued from event handlers anywhere in the app and drained by the canvas loop.
const ripples = [];
export function stir(x, y, strength = 0.6) {
  ripples.push({ x, y, strength, age: 0 });
  if (ripples.length > 12) ripples.shift();
}
export function stirFrom(element, strength) {
  const box = element?.getBoundingClientRect();
  if (box) stir(box.left + box.width / 2, box.top + box.height / 2, strength);
}

let kicks = 0;
export function kick(amount = 0.15) {
  kicks = Math.min(1.2, kicks + amount);
}

const TAU = Math.PI * 2;
const random = (min, max) => min + Math.random() * (max - min);

function sprite(rgb) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const light = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  light.addColorStop(0, `rgba(${rgb}, 1)`);
  light.addColorStop(0.35, `rgba(${rgb}, 0.35)`);
  light.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

function mote(lit) {
  return {
    x: Math.random(),
    y: Math.random(),
    z: random(0.25, 1),
    drift: random(-0.004, 0.004),
    rise: random(0.0015, 0.006),
    phase: random(0, TAU),
    glow: 0,
    lit,
  };
}

/**
 * The home's memory drawn as light in deep water: one lit mote per saved record,
 * ambient plankton around them, and a ridgeline tide that answers typing,
 * dictation and work in progress.
 */
export function Ambient({ records = 0, quiet = false, started = false }) {
  const attach = useCallback((canvas) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const sprites = { lit: sprite("10, 190, 255"), dust: sprite("120, 220, 235") };
    const pointer = { x: -999, y: -999, seen: 0 };
    let width = 0,
      height = 0,
      ratio = 1,
      frame = 0,
      tick = 0,
      last = performance.now(),
      energy = 0.3,
      surge = 0,
      sweep = -0.2,
      composer = null,
      wake = 0,
      motes = [];
    // A 3D model canvas owns the GPU while it is on screen.
    const yielding = () =>
      Boolean(canvas.dataset.quiet || document.querySelector(".spaces-workspace canvas, .guide-debug canvas"));

    function populate() {
      const target = Number(canvas.dataset.records) || 0;
      const lit = Math.min(target, 140);
      const dust = Math.round(Math.min(230, (width * height) / 6500));
      const current = motes.filter((m) => m.lit).length;
      if (current !== lit || motes.length !== lit + dust)
        motes = [
          ...motes.filter((m) => m.lit).slice(0, lit),
          ...Array.from({ length: Math.max(0, lit - current) }, () => mote(true)),
          ...motes.filter((m) => !m.lit).slice(0, dust),
          ...Array.from(
            { length: Math.max(0, dust - motes.filter((m) => !m.lit).length) },
            () => mote(false),
          ),
        ];
    }
    function resize() {
      ratio = Math.min(devicePixelRatio || 1, 1.5);
      width = innerWidth;
      height = innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      populate();
      if (still.matches) draw(0);
    }

    function drawMotes(dt, time) {
      ctx.globalCompositeOperation = "lighter";
      for (const m of motes) {
        m.x += m.drift * dt * m.z;
        m.y -= m.rise * dt * m.z;
        if (m.y < -0.02) m.y = 1.02;
        if (m.x < -0.02) m.x = 1.02;
        if (m.x > 1.02) m.x = -0.02;
        const px = m.x * width,
          py = m.y * height;
        const near = Math.hypot(px - pointer.x, py - pointer.y);
        let touch = near < 150 ? (1 - near / 150) ** 2 : 0;
        if (touch > 0.05) {
          m.x += ((px - pointer.x) / (near || 1)) * touch * 0.0009 * dt;
          m.y += ((py - pointer.y) / (near || 1)) * touch * 0.0009 * dt;
        }
        for (const r of ripples) {
          const band = Math.abs(Math.hypot(px - r.x, py - r.y) - r.age * 420);
          if (band < 40) touch = Math.max(touch, (1 - band / 40) * r.strength);
        }
        m.glow = Math.max(m.glow * 0.965, touch);
        const twinkle = 0.55 + 0.45 * Math.sin(time * 0.0012 + m.phase);
        const base = m.lit ? 0.38 + 0.4 * twinkle : 0.16 + 0.16 * twinkle;
        const alpha = Math.min(1, (base + m.glow * 0.9) * m.z);
        const size = (m.lit ? 2 : 1.1) * m.z + m.glow * 1.6;
        const halo = size * (m.lit ? 7 : 4);
        ctx.globalAlpha = alpha * (m.lit ? 0.85 : 0.5);
        ctx.drawImage(m.lit ? sprites.lit : sprites.dust, px - halo, py - halo, halo * 2, halo * 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(225, 248, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, TAU);
        ctx.fill();
      }
      ctx.lineWidth = 1;
      for (const r of ripples) {
        const radius = r.age * 420,
          fade = Math.max(0, 1 - r.age / 1.6) * r.strength;
        ctx.strokeStyle = `rgba(63, 242, 199, ${fade * 0.22})`;
        ctx.beginPath();
        ctx.arc(r.x, r.y, radius, 0, TAU);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    function drawTide(time, state) {
      const calm = canvas.dataset.started ? 0.45 : 1;
      const tall = canvas.dataset.started ? 0.12 : 0.22;
      const lines = 7,
        top = height * (1 - tall),
        gap = (height - top) / (lines + 1);
      const box = composer?.getBoundingClientRect();
      const center = box ? box.left + box.width / 2 : width / 2;
      const spread = Math.max(220, (box?.width || 640) * 0.55);
      for (let k = 0; k < lines; k++) {
        const base = top + gap * (k + 1);
        const depth = (k + 1) / lines;
        ctx.beginPath();
        ctx.moveTo(-10, height + 10);
        for (let x = -10; x <= width + 10; x += 7) {
          const off = (x - center) / spread;
          const envelope = Math.exp(-off * off * 1.6);
          const travel =
            state === "busy"
              ? Math.exp(-(((x / width - sweep) * 7) ** 2)) * 1.4
              : 0;
          const reach = Math.exp(-(((x - pointer.x) / 160) ** 2)) * pointer.seen;
          const wave =
            Math.sin(x * 0.011 + time * 0.0011 + k * 1.7) * 0.5 +
            Math.sin(x * 0.027 - time * 0.0017 + k * 0.6) * 0.32 +
            Math.sin(x * 0.061 + time * 0.0033 + k * 2.3) * 0.18 * energy;
          const lift =
            (envelope * (0.35 + energy) + travel + reach * 0.35) *
            Math.abs(wave) *
            gap *
            (2.1 + depth) *
            calm;
          ctx.lineTo(x, base - lift - envelope * gap * 0.25);
        }
        ctx.lineTo(width + 10, height + 10);
        ctx.closePath();
        ctx.fillStyle = `rgba(18, 27, 32, ${0.82 + depth * 0.16})`;
        ctx.fill();
        // Crests carry light: teal where the swell is highest, fading to cyan and into the abyss.
        const strength = (0.55 - depth * 0.3 + energy * 0.3) * calm;
        const light = ctx.createLinearGradient(0, base - gap * 3.2, 0, base);
        light.addColorStop(0, `rgba(63, 242, 199, ${strength})`);
        light.addColorStop(0.55, `rgba(10, 190, 255, ${strength * 0.7})`);
        light.addColorStop(1, `rgba(10, 190, 255, ${strength * 0.18})`);
        ctx.strokeStyle = light;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
    }

    function draw(time) {
      const now = performance.now();
      const dt = still.matches ? 0 : Math.min(3, (now - last) / 16.7);
      last = now;
      if (tick++ % 30 === 0) {
        composer = document.querySelector(".composer, .voice-orb");
        populate();
      }
      const state = composer?.dataset.state || "idle";
      const goal =
        state === "listening" ? 1.25 : state === "busy" ? 0.75 : 0.42;
      energy += (goal + surge - energy) * 0.04 * (dt || 1);
      surge = Math.min(1.4, surge * 0.97 + kicks);
      kicks = 0;
      sweep = state === "busy" ? (sweep + 0.006 * dt) % 1.4 : -0.2;
      pointer.seen *= 0.985;
      for (const r of ripples) {
        if (r.age === 0) surge = Math.max(surge, r.strength * 0.9);
        r.age += 0.016 * dt;
      }
      while (ripples.length && ripples[0].age > 1.6) ripples.shift();
      ctx.clearRect(0, 0, width, height);
      drawMotes(dt, time);
      drawTide(time, state);
    }

    function loop(time) {
      if (tick % 30 === 0 && yielding()) return run();
      draw(time);
      frame = requestAnimationFrame(loop);
    }
    function run() {
      cancelAnimationFrame(frame);
      clearTimeout(wake);
      canvas.hidden = yielding();
      if (canvas.hidden) {
        wake = setTimeout(run, 1000);
        return;
      }
      if (still.matches || document.hidden) return draw(0);
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }
    function move(event) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.seen = 1;
    }
    function press(event) {
      if (event.pointerType !== "touch") stir(event.clientX, event.clientY, 0.45);
    }
    const watch = new MutationObserver(run);
    watch.observe(canvas, { attributes: true, attributeFilter: ["data-quiet"] });
    addEventListener("resize", resize);
    addEventListener("pointermove", move, { passive: true });
    addEventListener("pointerdown", press, { passive: true });
    document.addEventListener("visibilitychange", run);
    still.addEventListener("change", run);
    resize();
    run();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(wake);
      watch.disconnect();
      removeEventListener("resize", resize);
      removeEventListener("pointermove", move);
      removeEventListener("pointerdown", press);
      document.removeEventListener("visibilitychange", run);
      still.removeEventListener("change", run);
    };
  }, []);
  return (
    <canvas
      className="ambient"
      ref={attach}
      aria-hidden="true"
      data-records={records}
      data-quiet={quiet ? "" : undefined}
      data-started={started ? "" : undefined}
    />
  );
}
