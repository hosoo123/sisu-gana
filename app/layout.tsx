import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SISU Live Quiz",
  description: "Host a live quiz or join from your phone.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
