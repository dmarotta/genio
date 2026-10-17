/** No preview for this asset: the real reason. The inspector's own buttons open or reveal the file. */
export function PreviewUnavailable({ title, reason }: { title: string; reason: string }) {
  return <div className="inventory-preview-info" role="status">
    <strong>{title}</strong>
    <p>{reason}</p>
  </div>
}
