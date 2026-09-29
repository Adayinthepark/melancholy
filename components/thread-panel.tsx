"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";

export function ThreadPanel({
  children,
  focused,
  onClose,
}: {
  children: ReactNode;
  focused: boolean;
  onClose: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, mobile: false });
  const reduced = useReducedMotion();
  const present = useIsPresent();
  useLayoutEffect(() => {
    const parent = frame.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const width = parent.clientWidth;
      const mobile = matchMedia("(max-width: 760px)").matches;
      setSize({
        width: focused ? Math.min(width, 920) : width,
        mobile,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [focused]);
  useLayoutEffect(() => {
    if (!present || focused) return;
    const target =
      frame.current?.querySelector<HTMLTextAreaElement>("textarea");
    target?.focus({ preventScroll: true });
  }, [present, focused]);
  const overlay = size.mobile && !focused;
  const duration = reduced || focused ? 0 : 0.24;
  return (
    <motion.div
      ref={frame}
      className={"thread-panel-frame" + (focused ? " is-focused" : "")}
      data-present={present}
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      initial={focused || reduced ? false : { opacity: 0 }}
      style={{ width: "100%", height: "100%" }}
      animate={{ opacity: 1 }}
      exit={
        overlay
          ? { opacity: 1, transition: { duration: 0.01, delay: duration } }
          : { opacity: 0 }
      }
      transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !focused) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <motion.section
        className="team-thread"
        aria-label="Thread"
        style={{ width: size.width }}
        initial={
          focused || reduced ? false : { x: overlay ? "100%" : 12, opacity: 0 }
        }
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: overlay ? size.width : 24, opacity: overlay ? 1 : 0 }}
        transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.section>
    </motion.div>
  );
}
