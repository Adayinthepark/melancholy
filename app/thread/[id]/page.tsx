import { TeamWorkspaceApp } from "@/components/team-workspace";
export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TeamWorkspaceApp focusedThread={id} />;
}
