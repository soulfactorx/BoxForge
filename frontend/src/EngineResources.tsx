import { useEffect, useState } from "react";
import { call, type Run } from "./bridge";
import { bytes } from "./format";
import { Dialog } from "./ui";

interface Res {
  available: boolean;
  own: boolean;
  memoryGB: number;
  processors: number;
  swapGB: number;
  sparse: boolean;
  diskBytes: number;
  pending: boolean;
  cpus: number;
}

/** The WSL machine's limits (memory, processors, swap) and the engine's disk: Windows only. */
export default function EngineResources({ run }: { run: Run }) {
  const [r, setR] = useState<Res | null>(null);
  const [mem, setMem] = useState("");
  const [cpu, setCpu] = useState("");
  const [swap, setSwap] = useState("");
  const [asking, setAsking] = useState<"apply" | "sparse" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    call<Res>("EngineResources").then((x) => {
      setR(x);
      setMem(x.memoryGB ? String(x.memoryGB) : "");
      setCpu(x.processors ? String(x.processors) : "");
      setSwap(x.swapGB ? String(x.swapGB) : "");
    }, () => {});
  useEffect(() => {
    load();
  }, []);
  if (!r?.available) return null;

  const want = { memoryGB: +mem || 0, processors: +cpu || 0, swapGB: +swap || 0 };
  const changed = want.memoryGB !== r.memoryGB || want.processors !== r.processors || want.swapGB !== r.swapGB;
  const bad = want.processors > r.cpus;
  const lines = [want.memoryGB && `memory=${want.memoryGB}GB`, want.processors && `processors=${want.processors}`, want.swapGB && `swap=${want.swapGB}GB`].filter(Boolean).join(", ");

  const save = async (restart: boolean) => {
    setAsking(null);
    setError("");
    const command = `# %UserProfile%\\.wslconfig 의 [wsl2]: ${lines || "제한 없음"}${restart ? " → wsl --shutdown" : ""}`;
    if (await run(command, () => call("SetEngineResources", { ...want, sparse: r.sparse, diskBytes: 0, pending: false }, restart))) {
      setNote(restart ? "적용했습니다. WSL이 다시 시작되어 엔진이 곧 다시 연결됩니다." : "저장했습니다. WSL을 다시 시작할 때(PC를 다시 켤 때 등) 적용됩니다.");
      load();
    }
  };
  const sparse = async () => {
    setAsking(null);
    if (await run(`wsl --shutdown && wsl --manage BoxForge --set-sparse ${!r.sparse}`, () => call("SetEngineSparse", !r.sparse))) {
      setNote(r.sparse ? "디스크 자동 줄이기를 껐습니다." : "디스크 자동 줄이기를 켰습니다. 지운 파일의 자리가 Windows로 돌아갑니다.");
      load();
    }
  };

  return (
    <div className="panel" data-testid="engine-resources">
      <h2>엔진 자원 (WSL)</h2>
      <p className="muted">
        WSL 안의 엔진이 쓸 수 있는 메모리와 CPU입니다. WSL 전체의 설정이라 다른 WSL 배포판도 같이 적용되고, WSL을 다시 시작해야 반영됩니다. 비워 두면 WSL의 기본값(메모리의
        절반, CPU 전부)을 씁니다.
      </p>
      {note && <p className="note">{note}</p>}
      {r.pending && <p className="note-box">저장한 값이 아직 적용되지 않았습니다. WSL을 다시 시작하면 적용됩니다.</p>}
      <form
        className="run-form resources-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && !bad) setAsking("apply");
        }}
      >
        <label>
          메모리 (GB)
          <input inputMode="numeric" aria-label="WSL 메모리 (GB)" placeholder="기본값" value={mem} onChange={(e) => setMem(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label>
          CPU (개)
          <input inputMode="numeric" aria-label="WSL CPU (개)" placeholder={`기본값 (이 PC: ${r.cpus}개)`} value={cpu} onChange={(e) => setCpu(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label>
          스왑 (GB)
          <input inputMode="numeric" aria-label="WSL 스왑 (GB)" placeholder="기본값" value={swap} onChange={(e) => setSwap(e.target.value.replace(/\D/g, ""))} />
        </label>
        <div className="dialog-actions">
          {bad && <span className="warn">이 PC의 CPU는 {r.cpus}개입니다.</span>}
          <button type="submit" disabled={!changed || bad}>
            저장
          </button>
        </div>
      </form>
      {r.own && (
        <div className="setting">
          <span>
            <strong>엔진 디스크 {r.diskBytes > 0 && <span className="muted">· 지금 {bytes(r.diskBytes)}</span>}</strong>
            <span className="sub">
              WSL의 가상 디스크는 파일을 지워도 크기가 줄지 않습니다. "자동 줄이기"를 켜면 지운 만큼 Windows로 돌려줍니다(WSL 2.0 이상). 켜고 끌 때 WSL이 잠깐
              멈춥니다.
            </span>
          </span>
          <span className="setting-actions">
            <span className="muted">{r.sparse ? "켜짐" : "꺼짐"}</span>
            <button type="button" onClick={() => setAsking("sparse")}>
              {r.sparse ? "자동 줄이기 끄기" : "자동 줄이기 켜기"}
            </button>
          </span>
        </div>
      )}
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {asking && (
        <Dialog title={asking === "apply" ? "WSL 자원 바꾸기" : "엔진 디스크 자동 줄이기"} onClose={() => setAsking(null)}>
          {asking === "apply" ? (
            <p>
              <code>.wslconfig</code>에 {lines || "제한 없음"}을 적습니다. 바로 적용하려면 WSL을 다시 시작해야 하며, 그러면 <strong>모든 WSL 배포판과 그 안의 컨테이너가 잠깐
              멈춥니다</strong>(다시 시작 정책이 있는 컨테이너는 엔진과 함께 다시 켜집니다). 원래 파일은 <code>.wslconfig.boxforge-backup</code>으로 남겨 둡니다.
            </p>
          ) : (
            <p>
              이 설정을 바꾸려면 WSL을 멈춰야 합니다. <strong>모든 WSL 배포판과 그 안의 컨테이너가 잠깐 멈춥니다.</strong>
            </p>
          )}
          <div className="dialog-actions">
            <button onClick={() => setAsking(null)}>취소</button>
            {asking === "apply" && <button onClick={() => save(false)}>저장만 (나중에 적용)</button>}
            <button className="primary" onClick={() => (asking === "apply" ? save(true) : sparse())}>
              {asking === "apply" ? "저장하고 지금 적용" : "WSL 멈추고 바꾸기"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
