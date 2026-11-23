// WSL's virtual disks (Windows): each distribution's ext4.vhdx grows as
// files are written and never shrinks by itself. Here each is listed with
// its size and can be shrunk: free blocks are marked (fstrim), WSL is
// stopped, and Windows compacts the file (diskpart, as administrator).
import { useEffect, useState } from "react";
import { call, on, type Run } from "./bridge";
import { bytes } from "./format";
import { Dialog, Note } from "./ui";

interface Disk {
  distro: string;
  path: string;
  bytes: number;
  sparse: boolean;
  own: boolean;
}
interface Result {
  before: number;
  after: number;
  sparse: boolean;
  trim: string;
  trimmed: boolean;
  log: string;
}

export default function WSLDisks({ run }: { run: Run }) {
  const [disks, setDisks] = useState<Disk[]>([]);
  const [asking, setAsking] = useState<Disk | null>(null);
  const [busy, setBusy] = useState("");
  const [step, setStep] = useState("");
  const [done, setDone] = useState<{ distro: string; r: Result } | null>(null);
  const load = () => call<Disk[]>("WSLDisks").then(setDisks, () => {});
  useEffect(() => {
    load();
    return on("disk-compact", (text: string) => setStep(text));
  }, []);
  if (disks.length === 0) return null;

  const compact = async (d: Disk) => {
    setAsking(null);
    setBusy(d.distro);
    setStep("");
    const command = [`wsl -d ${d.distro} -u root -- fstrim -a`, "wsl --shutdown", `diskpart  # select vdisk file="${d.path}" → attach vdisk readonly → compact vdisk → detach vdisk`].join(" && ");
    setDone(null);
    let result: Result | null = null;
    await run(command, () => call<Result>("CompactWSLDisk", d.distro).then((r) => (result = r)));
    setBusy("");
    setStep("");
    if (result) setDone({ distro: d.distro, r: result });
    load();
  };

  return (
    <div className="panel" data-testid="wsl-disks">
      <h2>WSL 가상 디스크</h2>
      <p className="muted">
        WSL의 배포판(BoxForge, Kiri, Docker 등)마다 가상 디스크 파일(ext4.vhdx)이 있습니다. 안에서 이미지나 컨테이너를 지워도 이 파일은 줄지 않습니다. "줄이기"는 지운 만큼을
        Windows로 돌려줍니다. 먼저 안 쓰는 이미지 · 컨테이너를 정리하면 더 많이 줄어듭니다.
      </p>
      {done && <Outcome distro={done.distro} r={done.r} onClose={() => setDone(null)} />}
      {busy && (
        <p className="note" role="status" data-testid="compacting">
          <span className="spinner" /> {step || `${busy}의 디스크를 줄이는 중…`}
        </p>
      )}
      <table className="grid">
        <thead>
          <tr>
            <th>배포판</th>
            <th>파일</th>
            <th>차지하는 크기</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {disks.map((d) => (
            <tr key={d.distro} data-testid={`wsl-disk-${d.distro}`}>
              <td>
                {d.distro} {d.own && <span className="muted">(BoxForge 엔진)</span>}
              </td>
              <td>
                <code className="path">{d.path}</code>
              </td>
              <td>
                {bytes(d.bytes)} {d.sparse && <span className="muted">(자동 줄이기 켜짐)</span>}
              </td>
              <td>
                <button type="button" disabled={!!busy} onClick={() => setAsking(d)}>
                  줄이기
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {asking && (
        <Dialog title={`${asking.distro}의 가상 디스크 줄이기`} onClose={() => setAsking(null)}>
          <p>{`지금 ${bytes(asking.bytes)}인 ${asking.path} 를 줄입니다. 파일 안의 데이터는 지우지 않습니다. 이렇게 합니다:`}</p>
          <ol>
            <li>배포판 안에서 지운 파일의 자리를 비웁니다(fstrim).</li>
            <li>
              WSL을 멈춥니다. <strong>모든 WSL 배포판(BoxForge, Kiri 등)과 그 안의 컨테이너가 멈춥니다.</strong> 다시 시작 정책이 있는 컨테이너는 엔진과 함께 다시 켜집니다.
            </li>
            <li>Windows가 파일을 압축합니다(diskpart). 관리자 권한을 묻는 창이 뜨면 "예"를 누르세요. 디스크가 크면 몇 분 걸립니다.</li>
          </ol>
          <p className="help">안 쓰는 이미지 · 컨테이너 · 빌드 캐시를 먼저 지우면 더 많이 줄어듭니다: 홈 화면의 "디스크 정리"에서 무엇이 지워지는지 보고 지울 수 있습니다.</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setAsking(null)}>
              취소
            </button>
            <button type="button" className="primary" onClick={() => compact(asking)}>
              WSL 멈추고 줄이기
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** What shrinking did, and when nothing came back, why. */
function Outcome({ distro, r, onClose }: { distro: string; r: Result; onClose: () => void }) {
  const freed = r.before - r.after;
  return (
    <Note onClose={onClose} testid="compact-result">
      <strong>{freed > 0 ? `${distro}의 디스크: ${bytes(r.before)} → ${bytes(r.after)} (${bytes(freed)} 줄었습니다)` : `${distro}의 디스크가 줄지 않았습니다 (${bytes(r.before)})`}</strong>
      {!r.trimmed && (
        <span className="block warn">{`배포판 안에서 fstrim을 하지 못했습니다(${r.trim}). 그러면 Windows는 어느 자리가 비었는지 알 수 없어, 압축해도 거의 줄지 않습니다. 그 배포판에 fstrim(util-linux)을 설치하거나, 그 배포판을 만든 프로그램(Kiri 등)의 디스크 정리 기능을 쓰세요.`}</span>
      )}
      {r.trimmed && r.trim && <span className="block muted">{`fstrim: ${r.trim}`}</span>}
      {r.trimmed && freed <= 0 && (
        <span className="block muted">
          배포판 안에 지운 자리가 거의 없었습니다. 컨테이너 · 이미지 · 볼륨이 아직 그 엔진 안에 남아 있으면 공간을 그대로 차지합니다: 그 엔진을 켜고 먼저 정리(지우기)한 뒤 다시 줄여
          보세요.
        </span>
      )}
      {r.sparse && <span className="block muted">자동 줄이기(sparse)가 켜진 디스크라 diskpart 압축 대신 fstrim으로 바로 돌려주었습니다.</span>}
      {r.log && (
        <details>
          <summary>diskpart가 한 말</summary>
          <pre className="log-box">{r.log}</pre>
        </details>
      )}
    </Note>
  );
}
