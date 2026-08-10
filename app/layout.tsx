import type { Metadata } from "next";
import "./fonts.css";
import "./miithii-tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    "https://syncword-caption-studio.dhrub404.chatgpt.site",
  ),
  title: "subtitles — by miithii",
  description:
    "Make Assamese and Bodo subtitles land with expressive large and small words.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "subtitles — by miithii",
    description:
      "Assamese and Bodo subtitles with expressive large and small words.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1536,
        height: 1024,
        alt: "Miithii pulse bars showing a rhythm of small and large subtitle words",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "subtitles — by miithii",
    description:
      "Assamese and Bodo subtitles with expressive large and small words.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light">
      <body>{children}</body>
    </html>
  );
}
