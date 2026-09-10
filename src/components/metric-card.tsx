export function MetricCard({
  label,
  value,
  detail,
}: Readonly<{
  label: string;
  value: string;
  detail?: string;
}>) {
  return (
    <article className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {detail ? <p className="muted">{detail}</p> : null}
    </article>
  );
}
