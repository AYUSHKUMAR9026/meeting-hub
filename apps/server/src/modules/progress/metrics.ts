export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Calendar dates, independent of the length of a local DST day. Weeks start Monday. */
export function bucketDate(date: string, bucket: 'day' | 'week'): string {
  if (bucket === 'day') return date;
  return shiftDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}

export const isOverdue = (status: string, dueDate: string | null, today: string) =>
  status === 'open' && dueDate !== null && dueDate < today;
export const completionRate = (open: number, done: number) =>
  open + done ? Math.round((done / (open + done)) * 1000) / 10 : 0;

export function csv(rows: Record<string, string | number | boolean | null>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]!);
  const cell = (value: string | number | boolean | null | undefined) => {
    const raw = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return (
    [
      headers.map(cell).join(','),
      ...rows.map((row) => headers.map((key) => cell(row[key])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
