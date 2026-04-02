import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'DreamPlay Asset Generator',
    description: 'AI-powered product image & video asset pipeline for DreamPlay Pianos',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
