"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";

export function ConversationLayout({
  children,
  thread,
  open,
  focused,
}: {
  children: ReactNode;
  thread: ReactNode;
  open: boolean;
  focused: boolean;
}) {
  const [mobile, setMobile] = useState(false);
  const [initialWidth] = useState(() => {
    try {
      if (typeof window !== "undefined") {
        const stored = Number(localStorage.getItem("melancholy-thread-width"));
        if (stored >= 25 && stored <= 70) return stored;
      }
    } catch {
      /* Storage may be disabled. */
    }
    return 40;
  });
  const preferred = useRef(initialWidth);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={{
        conversation: 100 - preferred.current,
        thread: preferred.current,
      }}
      className="team-conversation-layout"
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction && open && !mobile && !focused) {
          preferred.current = (meta.requestedLayout || layout).thread;
          try {
            localStorage.setItem(
              "melancholy-thread-width",
              String(preferred.current),
            );
          } catch {
            /* Optional preference. */
          }
        }
      }}
    >
      <ResizablePanel
        id="conversation"
        className="conversation-panel"
        minSize={focused ? 0 : mobile || !open ? "100%" : "30%"}
        maxSize={focused ? "0%" : "100%"}
        defaultSize={
          focused
            ? "0%"
            : open && !mobile
              ? 100 - preferred.current + "%"
              : "100%"
        }
      >
        {children}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        className="thread-resize-handle"
        aria-label="Resize thread"
        disabled={!open || mobile || focused}
        style={{ display: !open || mobile || focused ? "none" : undefined }}
      />
      <ResizablePanel
        id="thread"
        className="thread-split-panel"
        data-open={open}
        minSize={focused ? "100%" : open && !mobile ? "25%" : 0}
        maxSize={focused ? "100%" : !open || mobile ? "0%" : "70%"}
        defaultSize={
          focused ? "100%" : open && !mobile ? preferred.current + "%" : "0%"
        }
      >
        {thread}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
