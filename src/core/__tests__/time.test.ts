import { describe, expect, it } from "bun:test";
import { localFileStamp, localTimestamp, localTimeStamp } from "../time";

// Expected values are derived from the same Date getters the helpers must
// use, so these pass in any TZ the suite runs under while still failing if
// a helper falls back to UTC (toISOString) — the two differ wherever the
// host offset is non-zero, which is every CI box outside UTC and every
// developer PC in Korea.
const d = new Date(2026, 9, 13, 13, 40, 37, 500); // local 2026-10-13 13:40:37.500

describe("local time helpers", () => {
  it("localFileStamp is yyyymmdd-hhmmss in the PC's time zone", () => {
    expect(localFileStamp(d)).toBe("20261013-134037");
  });

  it("localTimeStamp is hhmmss in the PC's time zone", () => {
    expect(localTimeStamp(d)).toBe("134037");
  });

  it("localTimestamp is human-readable with the UTC offset and zone name", () => {
    const out = localTimestamp(d);
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const hh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
    const mm = String(Math.abs(offsetMin) % 60).padStart(2, "0");
    // (bun test pins TZ to UTC, so the zone may legitimately print as "UTC"
    // here; the shape is what matters — offset and IANA name both present.)
    expect(out.startsWith("2026-10-13 13:40:37 ")).toBe(true);
    expect(out).toContain(`${sign}${hh}:${mm}`);
    expect(out).toMatch(/\(([A-Za-z_]+\/[A-Za-z_]+|UTC)\)$/);
    expect(out).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("differs from the UTC rendering whenever the host offset is non-zero", () => {
    const utc = d.toISOString().slice(0, 19).replace("T", " ");
    if (d.getTimezoneOffset() !== 0) {
      expect(localTimestamp(d).startsWith(utc)).toBe(false);
    } else {
      expect(localTimestamp(d).startsWith(utc)).toBe(true);
    }
  });
});
