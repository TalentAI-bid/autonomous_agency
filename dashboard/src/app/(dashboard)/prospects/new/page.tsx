import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { CaptureForm } from '@/components/prospects/capture-form';

export const metadata = { title: 'Add Prospect — KeenPipe' };

export default function NewProspectPage() {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
      <Link href="/prospects" className="inline-flex w-fit items-center gap-1.5 text-body font-medium text-ink-2 no-underline hover:text-accent">
        <ArrowLeft size={14} /> Back to prospects
      </Link>

      <div>
        <h1 className="m-0 font-display text-[28px] font-normal leading-tight tracking-[-0.01em] text-ink">Add a prospect</h1>
        <p className="mb-0 mt-1.5 max-w-[560px] text-body leading-relaxed text-ink-3">
          Capture a contact by hand. We dedupe against your pipeline and seed the timeline, so future
          events land in one place.
        </p>
      </div>

      <CaptureForm />
    </div>
  );
}
