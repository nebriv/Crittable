import { useEffect, useRef, useState } from "react";

/**
 * Wraps a horizontally scrollable region (a markdown table, typically) with a
 * subtle right-edge gradient when its content actually overflows. The
 * gradient is the visual cue the user-agent review asked for so an operator
 * doesn't assume the rightmost column was simply cut off.
 *
 * Re-evaluates on resize via ``ResizeObserver`` (when available) so toggling
 * the right sidebar / opening God Mode doesn't strand a stale shadow.
 */
export function TableScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function measure() {
      if (!el) return;
      const overflows = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
      setOverflowing(overflows);
    }
    measure();

    el.addEventListener("scroll", measure, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-table-scroll
      data-overflowing={overflowing ? "1" : "0"}
      className="mb-2 overflow-x-auto"
    >
      {children}
    </div>
  );
}
