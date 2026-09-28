"use client";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { SearchIcon } from "./icons/search";
import { SettingsIcon } from "./icons/settings";
import { ExpandIcon } from "./icons/expand";
import { MessageSquareIcon } from "./icons/message-square";
const icons = {
  search: SearchIcon,
  settings: SettingsIcon,
  expand: ExpandIcon,
  reply: MessageSquareIcon,
};
// Listen on the actual button/link so the whole hit area and keyboard focus
// receive the same feedback. The decorative icon never takes focus itself.
export function AnimatedIcon({
  name,
  size = 16,
}: {
  name: keyof typeof icons;
  size?: number;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const controls = useRef<{
    startAnimation: () => void;
    stopAnimation: () => void;
  }>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const target = element.current?.closest("button, a, [role=menuitem]");
    if (!target || reduced) return;
    const start = () => {
      if (!target.matches(":disabled")) controls.current?.startAnimation();
    };
    const stop = () => controls.current?.stopAnimation();
    target.addEventListener("pointerenter", start);
    target.addEventListener("pointerleave", stop);
    target.addEventListener("focus", start);
    target.addEventListener("blur", stop);
    return () => {
      target.removeEventListener("pointerenter", start);
      target.removeEventListener("pointerleave", stop);
      target.removeEventListener("focus", start);
      target.removeEventListener("blur", stop);
      stop();
    };
  }, [reduced]);
  const Icon = icons[name];
  return (
    <span ref={element} className="animated-icon" aria-hidden="true">
      <Icon ref={controls} size={size} />
    </span>
  );
}
