/** 計画・構造・混雑の警告（appState の computeStore.warnings）。色だけでなく記号と文で示す */
export function Warnings({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div class="warnings" role="alert">
      {items.map((w) => (
        <p key={w}>
          <span class="warn-icon" aria-hidden="true">!</span>
          {w}
        </p>
      ))}
    </div>
  );
}
