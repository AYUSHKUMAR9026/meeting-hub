/**
 * Date/time in a workspace's IANA time zone without a date library. Inputs use the
 * `<input type="datetime-local">` format, `YYYY-MM-DDTHH:mm`.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's offset from UTC at `date`, in milliseconds (e.g. +2 h for Berlin in summer). */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-10-03T09:30" in `timeZone` → the UTC instant. Gaps (DST spring-forward) roll forward. */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new RangeError(`expected YYYY-MM-DDTHH:mm, got "${local}"`);
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wallClock = Date.UTC(y, mo - 1, d, h, mi);
  const first = wallClock - offsetMs(new Date(wallClock), timeZone);
  const second = wallClock - offsetMs(new Date(first), timeZone);
  return new Date(first === second ? first : Math.max(first, second));
}

/** The UTC instant as "YYYY-MM-DDTHH:mm" on the wall clock in `timeZone`. */
export function utcToZonedLocal(date: Date | string, timeZone: string): string {
  const p = partsIn(new Date(date), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** e.g. "Sat, Oct 3, 2026, 9:30 AM GMT+2" in the workspace's zone. */
export function formatInZone(
  date: Date | string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  },
): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(date));
}

/** Start of the calendar day `day` ("YYYY-MM-DD") in `timeZone`, as a UTC instant. */
export const startOfDayInZone = (day: string, timeZone: string) =>
  zonedLocalToUtc(`${day}T00:00`, timeZone);

/** The day after "YYYY-MM-DD" (calendar arithmetic, no time zone involved). */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
