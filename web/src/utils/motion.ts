import { useEffect, useRef, useState, type RefObject } from "react";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Smooth cubic-out numeric roll-in for live telemetry readouts.
 * Respects prefers-reduced-motion and snaps immediately when null.
 */
export function useAnimatedNumber(
  target: number | null,
  durationMs = 520,
): number | null {
  const [display, setDisplay] = useState<number | null>(target);
  const prevRef = useRef<number>(target ?? 0);

  useEffect(() => {
    if (target === null) {
      setDisplay(null);
      prevRef.current = 0;
      return;
    }
    if (prefersReducedMotion()) {
      setDisplay(target);
      prevRef.current = target;
      return;
    }

    const from = prevRef.current;
    const delta = target - from;
    if (Math.abs(delta) < 1e-6) {
      setDisplay(target);
      return;
    }

    let rafId = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + delta * eased;
      setDisplay(val);
      if (t < 1) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        prevRef.current = target;
      }
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
      prevRef.current = target;
    };
  }, [target, durationMs]);

  return display;
}

/**
 * Lightweight IntersectionObserver hook for scroll-triggered architectural reveals.
 */
export function useInView(
  ref: RefObject<Element | null>,
  threshold = 0.14,
): boolean {
  const [inView, setInView] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold, inView]);

  return inView;
}
