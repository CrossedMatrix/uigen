import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Crossed Matrix — Institutional Market Dashboard",
  description: "Real-time FX, commodities, yield curve, and institutional flow monitoring.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/*
        suppressHydrationWarning: browser extensions (Grammarly, LastPass, etc.)
        inject attributes such as data-new-gr-c-s-check-loaded and
        data-gr-ext-installed onto <body> after React's server render.
        Without this flag React logs a hydration mismatch warning and may
        re-render the entire tree.  suppressHydrationWarning silences the
        warning for this single element only — child components are unaffected.
      */}
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
