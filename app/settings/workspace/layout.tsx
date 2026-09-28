import { WorkspaceSettingsPage } from "@/components/workspace-settings-page";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <WorkspaceSettingsPage />
      {children}
    </>
  );
}
