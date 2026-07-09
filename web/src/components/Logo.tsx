import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
// The r3 mark. Defined ONCE in web/favicon.svg — imported here as an asset (the
// bundler hashes it and hands back its URL) and referenced by the same file in
// index.html's <link rel="icon">, so favicon and nav logo can never drift apart.
// To keep that single source AND animate the mark's insides, we fetch the same
// asset once and inline it, rather than duplicating the SVG as JSX.
import logoUrl from "../../favicon.svg";

// --- fidget motion --------------------------------------------------------------
// flick() whirs the spinner (the .arms group + hub ball) two fast rounds, over-
// spins OVERSHOOT degrees past upright, and snaps back — old-cartoon style.
//
// The rotation is not a flat 2D turn: the arms aren't 120° apart because the mark
// is a 3D projection, so a plain rotate reads wrong. Instead the spin happens in
// a tilted plane and we render its projection: unsquash the artwork's y into
// plane space, rotate there, squash back — M(θ) = S(1,c)·R(θ)·S(1,1/c) with
// c = TILT. Arms sweep an ellipse (wide side-reach, foreshortened top/bottom)
// with the non-uniform apparent speed of a real ground-plane spinner. On top, a
// bell envelope shrinks + lifts the whole spinner mid-whir (it "takes off" while
// spinning, lands before the recoil), which also keeps the wider sweep inside
// the tile.
// Keep DIP ≈ 1−TILT: the peak shrink then cancels the ellipse's 1/tiltC
// overreach, so the wider sweep stays inside the tile at every phase.
const TILT = 0.82; // cos of the spin-plane tilt — the sweep ellipse's aspect
const TURNS_PER_FLICK = 2;
const MAX_STACKED_TURNS = 6; // clicks mid-spin extend the whir, up to this
const OVERSHOOT = 25; // deg past upright at the apex, recoiled back
const WHIR_MS_PER_REV = 423; // standard flick: 745° ⇒ 875ms whir…
const RECOIL_MS = 125; // …+ the snap back home = 1s in all
const DIP = 0.15; // envelope: shrink to 85% at peak whir…
const LIFT = 8; // …and hop up 8 user-units toward the tile center
const BELL_SPEED = 1.5; // deg/ms of whir at which the lift/shrink envelope saturates

const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) ** 2);

export interface LogoHandle {
  /** Give the spikes a spin — clicks mid-spin extend the whir. */
  flick(): void;
}

// One fetch per page load, shared by every Logo instance. The URL is the same
// asset the <link rel="icon"> already loaded, so this is a cache hit.
let markSvg: string | undefined;
let markPromise: Promise<string> | undefined;
function loadMark(): Promise<string> {
  markPromise ??= fetch(logoUrl)
    .then((r) => r.text())
    .then((text) => {
      markSvg = text;
      return text;
    });
  return markPromise;
}

export function Logo({ className, ref }: { className?: string; ref?: Ref<LogoHandle> }) {
  const [svg, setSvg] = useState(markSvg);
  const host = useRef<HTMLSpanElement>(null);
  // Animation state lives in refs — the rAF loop mutates the DOM directly.
  // rest is always a multiple of 360, so the mark lands exactly upright; bell is
  // the smoothed lift/shrink envelope, prev the last frame's timestamp.
  const anim = useRef<{
    t0: number;
    from: number;
    rest: number;
    bell: number;
    prev: number;
  } | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    if (!svg) loadMark().then(setSvg, () => {}); // fetch failure ⇒ keep the <img>
    return () => cancelAnimationFrame(raf.current);
  }, [svg]);

  useImperativeHandle(
    ref,
    () => ({
      flick() {
        const arms = host.current?.querySelector<SVGGElement>(".arms");
        const hub = arms?.parentElement?.querySelector("circle");
        if (!arms || !hub) {
          // Inline mark not loaded, or a stale copy without the .arms group
          // (e.g. a hot-swapped tab fetching a pre-restart asset). Don't fail
          // silently — this took a debugging session to find once already.
          console.warn("r3: logo mark has no spinner to spin — hard-reload the tab?");
          return;
        }
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

        // θ(t): fast ease-out whir from `from` up to rest+OVERSHOOT, then a
        // slower recoil back down to rest. Both angles in degrees.
        const whirMsFor = (from: number, rest: number) =>
          Math.min(Math.max(((rest + OVERSHOOT - from) / 360) * WHIR_MS_PER_REV, 500), 1800);
        const angleAt = (tRaw: number, from: number, rest: number) => {
          const t = Math.max(tRaw, 0); // a retarget can put the prev frame before t0
          const apex = rest + OVERSHOOT;
          const whirMs = whirMsFor(from, rest);
          if (t < whirMs) return from + (apex - from) * easeOutCubic(t / whirMs);
          if (t < whirMs + RECOIL_MS)
            return apex - OVERSHOOT * easeInOutQuad((t - whirMs) / RECOIL_MS);
          return null; // done
        };

        const apply = (theta: number, bell: number) => {
          const s = 1 - DIP * bell;
          const lift = LIFT * bell;
          // The plane tips over with the same envelope: the spin starts flat
          // (no ellipse, so the first fast quarter-turn can't overreach the
          // tile), tilts into the 3D sweep while airborne, levels out to land.
          // The s-shrink cancels the 1/tiltC unsquash, bounding the sweep.
          const tiltC = 1 - (1 - TILT) * bell;
          const r = (theta * Math.PI) / 180;
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          // S(1,c)·R(θ)·S(1,1/c), column-major SVG matrix(a b c d e f).
          arms.setAttribute(
            "transform",
            `translate(0 ${-lift}) scale(${s}) matrix(${cos} ${tiltC * sin} ${-sin / tiltC} ${cos} 0 0)`,
          );
          hub.setAttribute("transform", `translate(0 ${-lift}) scale(${s})`);
        };

        const now = performance.now();
        if (anim.current) {
          // Mid-spin click: extend the whir by two more rounds (capped) and
          // restart the curve from the current angle so θ stays continuous.
          const a = anim.current;
          const theta = angleAt(now - a.t0, a.from, a.rest) ?? a.rest;
          if (a.rest - theta < (MAX_STACKED_TURNS - TURNS_PER_FLICK) * 360) {
            anim.current = { ...a, t0: now, from: theta, rest: a.rest + TURNS_PER_FLICK * 360 };
          }
          return; // the running loop picks the new target up
        }
        anim.current = { t0: now, from: 0, rest: TURNS_PER_FLICK * 360, bell: 0, prev: now };

        const step = (frameNow: number) => {
          const a = anim.current;
          if (!a) return;
          const theta = angleAt(frameNow - a.t0, a.from, a.rest);
          if (theta === null) {
            // Landed upright: drop the inline transforms so the SVG's own
            // markup is authoritative again.
            arms.removeAttribute("transform");
            hub.removeAttribute("transform");
            anim.current = null;
            raf.current = 0;
            return;
          }
          // The lift/shrink envelope chases angular speed with ~80ms smoothing:
          // continuous even across mid-spin retargets, ~1 while whirring, and
          // back to ~0 for the landing so the recoil twitch happens grounded.
          const dt = frameNow - a.prev;
          const prevTheta = angleAt(a.prev - a.t0, a.from, a.rest) ?? theta;
          const speed = dt > 0 ? (theta - prevTheta) / dt : 0; // deg/ms
          a.bell += (Math.min(speed / BELL_SPEED, 1) - a.bell) * Math.min(dt / 80, 1);
          a.prev = frameNow;
          apply(theta, a.bell);
          raf.current = requestAnimationFrame(step);
        };
        raf.current = requestAnimationFrame(step);
      },
    }),
    [],
  );

  // Until the inline copy arrives, render the asset as before — same pixels.
  if (!svg) return <img src={logoUrl} alt="" className={className} />;
  return (
    <span
      ref={host}
      aria-hidden="true"
      className={`inline-block [&>svg]:block [&>svg]:size-full [&>svg]:overflow-visible ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
