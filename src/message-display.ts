/** Internal model reminders are context, not user-facing conversation. */
export function isInternalReminder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>");
}
