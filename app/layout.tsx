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
    title: "SyncWord — Sync first. Render once.",
    description:
      "Review and correct Assamese and Bodo word timing over the original video, then render styled ASS captions once.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "SyncWord",
      description: "Sync first. Render once.",
      type: "website",
      url: origin,
      images: [
        {
          url: `${origin}/og-correction.png`,
          width: 1536,
          height: 1024,
          alt: "SyncWord correction-first mobile caption editor",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "SyncWord",
      description: "Sync first. Render once.",
      images: [`${origin}/og-correction.png`],
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
