"use client";
import { useEffect, useRef, type RefObject } from "react";
import type { TeamMessage } from "@/lib/chat";

// A short dwell avoids acknowledging messages merely passed while scrolling.
export function MessageReadTracker({
  viewport,
  messages,
  onRead,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  messages: TeamMessage[];
  onRead?: (ids: string[]) => Promise<void>;
}) {
  const callback = useRef(onRead);
  callback.current = onRead;
  const ids = messages
    .filter((m) => m.unread && !m.delivery)
    .map((m) => m.id)
    .join(",");
  useEffect(() => {
    const root = viewport.current;
    if (!root || !onRead || !ids) return;
    const wanted = new Set(ids.split(","));
    const visible = new Map<string, Element>();
    const acknowledged = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const readable = (element: Element) => {
      const bounds = element.getBoundingClientRect(),
        frame = root.getBoundingClientRect();
      const height =
        Math.min(bounds.bottom, frame.bottom) - Math.max(bounds.top, frame.top);
      return (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        getComputedStyle(element).visibility === "visible" &&
        frame.height > 0 &&
        height >= Math.min(bounds.height, frame.height) * 0.5
      );
    };
    const schedule = () => {
      clearTimeout(timer);
      const candidates = [...visible].filter(
        ([id, element]) => !acknowledged.has(id) && readable(element),
      );
      if (!candidates.length) return;
      timer = setTimeout(() => {
        const batch = candidates
          .filter(([id, element]) => visible.has(id) && readable(element))
          .map(([id]) => id);
        if (!batch.length || stopped) return;
        batch.forEach((id) => acknowledged.add(id));
        void callback.current?.(batch).catch(() => {
          batch.forEach((id) => acknowledged.delete(id));
          if (!stopped) schedule();
        });
      }, 800);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId!;
          if (entry.isIntersecting) visible.set(id, entry.target);
          else visible.delete(id);
        }
        schedule();
      },
      { root, threshold: [0, 0.5, 1] },
    );
    root
      .querySelectorAll<HTMLElement>("article[data-message-id]")
      .forEach((row) => {
        if (wanted.has(row.dataset.messageId!)) observer.observe(row);
      });
    // Re-evaluate long rows whose intersection ratio cannot reach 0.5.
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      stopped = true;
      clearTimeout(timer);
      observer.disconnect();
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [ids, !!onRead, viewport]);
  return null;
}
