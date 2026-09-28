import { MotionPreferences } from "@/components/motion-preferences";
import { PwaProvider } from "@/components/pwa-provider";
import type { Metadata } from "next";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "melancholy",
  description: "A workspace for conversations with your agents.",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg", apple: "/icons/apple-touch-icon.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "melancholy",
    statusBarStyle: "default",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#f4f4f4" />
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('melancholy-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');document.querySelector('meta[name="theme-color"]').content='#171717'}}catch{}`,
          }}
        />
      </head>
      <body>
        <MotionPreferences>
          <PwaProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </PwaProvider>
        </MotionPreferences>
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
