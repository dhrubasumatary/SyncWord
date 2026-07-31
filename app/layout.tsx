import type { Metadata } from "next";
import { headers } from "next/headers";
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

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const host =
    headerList.get("x-forwarded-host") ??
    headerList.get("host") ??
    "localhost:3000";
  const protocol =
    headerList.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "SyncWord — Edit captions. Then export.",
    description:
      "Generate, edit, time, style, and export Assamese and Bodo captions in a mobile-first video editor.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "SyncWord",
      description: "Edit the caption. Not a dashboard.",
      type: "website",
      url: origin,
      images: [
        {
          url: `${origin}/og-editor.png`,
          width: 1536,
          height: 1024,
          alt: "SyncWord mobile caption editor",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "SyncWord",
      description: "Edit the caption. Not a dashboard.",
      images: [`${origin}/og-editor.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
