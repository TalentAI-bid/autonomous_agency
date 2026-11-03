import { redirect } from 'next/navigation';

// Settings has no landing page of its own; Profile is the first tab.
export default function SettingsIndexPage() {
  redirect('/settings/company');
}
