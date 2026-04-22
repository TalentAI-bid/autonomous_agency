import type { Metadata } from 'next';
import { Inter_Tight, JetBrains_Mono, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter = Inter_Tight({
  subsets: ['latin'],
  variable: '--ff-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--ff-mono',
  display: 'swap',
});

const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--ff-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TalentAI Sales — Autonomous Outbound',
  description: 'Autonomous B2B outbound sales on a multi-agent platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
