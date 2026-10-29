import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ava call log",
  description: "Call records and transcripts from the RSE AI receptionist",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
