import { flushSync } from "react-dom";

let current: ViewTransition | undefined;
let fallback: Animation | undefined;
let sequence = 0;
// Browser snapshots crossfade the content without unmounting editors or drafts.
export function transitionContent(update: () => void) {
  const id = ++sequence;
  current?.skipTransition();
  fallback?.cancel();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  if (!document.startViewTransition) {
    const content = document.querySelector(".team-conversation-layout");
    if (!content) {
      update();
      return;
    }
    fallback = content.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 80,
      fill: "forwards",
    });
    void fallback.finished
      .then(() => {
        if (id !== sequence) return;
        flushSync(update);
        fallback?.cancel();
        fallback = content.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 120,
        });
      })
      .catch(() => {});
    return;
  }
  current = document.startViewTransition(() => {
    if (id === sequence) flushSync(update);
  });
  void current.finished.catch(() => {});
}
