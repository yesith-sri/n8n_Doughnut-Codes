import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Oxanium, Roboto } from "next/font/google";
import "./globals.css";

const oxanium = Oxanium({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Forge \u00b7 Deployment Control",
  description:
    "Agentic deployment control plane. Ship a Docker image, approve the architecture, and watch the agents deploy to AWS, GCP, or Azure.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${oxanium.variable} ${roboto.variable} h-full antialiased`}
    >
      <body className="min-h-full font-body">{children}</body>
    </html>
  );
}
