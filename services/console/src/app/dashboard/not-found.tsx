import { ButtonLink, EmptyState } from "../_components/ui.tsx";

export default function DashboardNotFound() {
  return (
    <main className="flex-1 overflow-y-auto">
      <EmptyState title="Nothing here">
        <p>This page does not exist, or it belongs to something that has been removed.</p>
        <div className="pt-2">
          <ButtonLink href="/dashboard" variant="secondary">
            Back to overview
          </ButtonLink>
        </div>
      </EmptyState>
    </main>
  );
}
