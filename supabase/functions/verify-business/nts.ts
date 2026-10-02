// 국세청 사업자등록정보 상태조회 (공공데이터포털)
export type NtsStatus = "active" | "suspended" | "closed" | "unregistered";

export function bizDigits(v: string): string {
  return String(v || "").replace(/[^0-9]/g, "");
}

// 국세청 사업자등록번호 검증식
export function bizNoValid(v: string): boolean {
  const d = bizDigits(v);
  if (d.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * w[i];
  s += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (s % 10)) % 10 === Number(d[9]);
}

export function bizFormat(v: string): string {
  const d = bizDigits(v);
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

// 최대 100개 한 번에 조회. 실패하면 null
export async function ntsStatus(numbers: string[]): Promise<Record<string, NtsStatus> | null> {
  const key = Deno.env.get("NTS_SERVICE_KEY");
  if (!key || !numbers.length) return null;
  try {
    const res = await fetch(
      "https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=" + encodeURIComponent(key),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ b_no: numbers.map(bizDigits).slice(0, 100) }),
      },
    );
    if (!res.ok) {
      console.error("NTS HTTP", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const j = await res.json();
    if (!Array.isArray(j.data)) {
      console.error("NTS body", JSON.stringify(j).slice(0, 300));
      return null;
    }
    const out: Record<string, NtsStatus> = {};
    for (const row of j.data) {
      const code = String(row.b_stt_cd || "");
      out[bizDigits(row.b_no)] = code === "01" ? "active" : code === "02" ? "suspended" : code === "03" ? "closed" : "unregistered";
    }
    return out;
  } catch (e) {
    console.error("NTS error", e);
    return null;
  }
}
