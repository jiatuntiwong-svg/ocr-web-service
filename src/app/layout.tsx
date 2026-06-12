import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

export const metadata: Metadata = {
	title: "DOCRoom",
	description: "Intelligent OCR Workspace",
};

// Tell mobile/tablet browsers to render at device width (default = 980px on
// mobile, which scales the whole app down to fit). user-scalable kept on so
// users can still pinch-zoom into preview details.
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 5,
	userScalable: true,
};

// Runs before paint so the stored theme is applied without a flash.
// Defaults to dark when nothing is stored.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('docroom_theme');var d=t==null?true:t==='dark';if(d)document.documentElement.classList.add('dark');else document.documentElement.classList.remove('dark');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<head>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml"></link>
				<script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
			</head>
			<body className="antialiased">
				<LocaleProvider>{children}</LocaleProvider>
			</body>
		</html>
	);
}
