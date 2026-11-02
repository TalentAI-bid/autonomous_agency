import { SettingsNav } from '@/components/settings/settings-nav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5 p-6 md:flex-row md:items-start md:gap-6">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
