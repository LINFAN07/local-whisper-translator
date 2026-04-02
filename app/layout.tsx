import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "語音辨識與翻譯",
  description: "本機 Whisper 轉錄與翻譯工具",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant-TW" className="dark">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
