"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
export type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
const PwaContext = createContext<{
  install: InstallPrompt | null;
  standalone: boolean;
}>({ install: null, standalone: false });
export const usePwa = () => useContext(PwaContext);
export function PwaProvider({ children }: { children: ReactNode }) {
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const updateColor = () => {
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      );
      if (meta)
        meta.content = getComputedStyle(root)
          .getPropertyValue("--canvas")
          .trim();
    };
    updateColor();
    const observer = new MutationObserver(updateColor);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const query = matchMedia("(display-mode: standalone)");
    const update = () =>
      setStandalone(
        query.matches ||
          !!(navigator as Navigator & { standalone?: boolean }).standalone,
      );
    update();
    query.addEventListener("change", update);
    const prompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallPrompt);
    };
    const installed = () => {
      setInstall(null);
      update();
    };
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("appinstalled", installed);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    return () => {
      query.removeEventListener("change", update);
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  return (
    <PwaContext.Provider value={{ install, standalone }}>
      {children}
    </PwaContext.Provider>
  );
}
