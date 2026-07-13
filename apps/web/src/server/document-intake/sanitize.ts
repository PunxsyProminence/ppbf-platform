export function safePdfFileName(originalName: string): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-')
  const base = originalName
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const fallback = base || 'ppbf-upload'
  return `${fallback}-${now}.pdf`
}
