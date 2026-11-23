import type { ReactNode } from "react";
import { ButtonLink } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess } from "../../_lib/session.ts";
import { ListPane, SectionShell } from "../_components/panes.tsx";
import { StudioTree } from "./_components/tree.tsx";

export default async function StudioLayout({ children }: { children: ReactNode }) {
  const access = await requireChatAccess();
  const prompts = await consoleService().prompts(access);
  const list = (
    <ListPane title="Studio" actions={<ButtonLink href="/dashboard/studio/new">New</ButtonLink>}>
      <StudioTree prompts={prompts} />
    </ListPane>
  );
  return <SectionShell list={list}>{children}</SectionShell>;
}
