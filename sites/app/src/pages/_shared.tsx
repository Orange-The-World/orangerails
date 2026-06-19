// Placeholder pages for the dashboard. Each one renders a section name + planned content.
// Wired up to real data in Phase 1.



function PageScaffold({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-slate-600">{description}</p>
      <div className="mt-8 p-6 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500">
        Wired up in Phase 1.
      </div>
    </div>
  );
}

export { PageScaffold };
