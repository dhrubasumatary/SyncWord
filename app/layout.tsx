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
    title: "SyncWord — Make every word hit on time",
    description:
      "Phrase-anchored waveform alignment for Assamese and Bodo karaoke captions, with confidence review and ASS-powered rendering.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "SyncWord",
      description: "Make every word hit on time.",
      type: "website",
      url: origin,
      images: [
        {
          url: `${origin}/og-mobile.png`,
          width: 1536,
          height: 1024,
          alt: "SyncWord mobile word-timing caption workshop",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "SyncWord",
      description: "Make every word hit on time.",
      images: [`${origin}/og-mobile.png`],
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
