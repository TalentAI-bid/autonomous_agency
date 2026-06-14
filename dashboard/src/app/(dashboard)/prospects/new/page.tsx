import { CaptureForm } from '@/components/prospects/capture-form';

export const metadata = { title: 'Add Prospect — TalentAI' };

export default function NewProspectPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Add Prospect</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Capture a contact manually. We&apos;ll dedupe against your existing pipeline
          and seed the timeline so future events land in one place.
        </p>
      </div>
      <CaptureForm />
    </div>
  );
}
