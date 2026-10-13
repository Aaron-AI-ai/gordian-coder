/**
 * Human-facing timestamps in the PC's own time zone.
 *
 * Everything a person reads — report filenames, the "Generated:" line, run
 * ids — renders here, from the local clock. Machine-facing fields
 * (`createdAt`, `submittedAt`, judgment `at`) stay ISO-8601 UTC: they are
 * compared, pruned and hashed, and must not move when the PC's zone does.
 *
 * The zone is whatever the process sees (TZ env, else the OS setting);
 * `localTimestamp` prints the offset and IANA name beside the time so a
 * report made in Seoul still reads unambiguously in another zone.
 */

const two = (n: number): string => String(n).padStart(2, "0");

function parts(d: Date): { ymd: string; hms: string } {
  return {
    ymd: `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`,
    hms: `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`,
  };
}

/** `yyyymmdd-hhmmss`, local — report filenames and f-log run ids. */
export function localFileStamp(d: Date = new Date()): string {
  const { ymd, hms } = parts(d);
  return `${ymd}-${hms}`;
}

/** `hhmmss`, local — the time half of a review run id. */
export function localTimeStamp(d: Date = new Date()): string {
  return parts(d).hms;
}

/** `+09:00`-style UTC offset of `d` in the local zone. */
export function localOffset(d: Date = new Date()): string {
  const min = -d.getTimezoneOffset();
  const sign = min >= 0 ? "+" : "-";
  return `${sign}${two(Math.floor(Math.abs(min) / 60))}:${two(Math.abs(min) % 60)}`;
}

/** `2026-10-13 13:40:37 +09:00 (Asia/Seoul)` — the human-readable form. */
export function localTimestamp(d: Date = new Date()): string {
  const { ymd, hms } = parts(d);
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const time = `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${date} ${time} ${localOffset(d)} (${zone})`;
}
