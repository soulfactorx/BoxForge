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
  own: boolean;
}

export default function WSLDisks({ run }: { run: Run }) {
  const [disks, setDisks] = useState<Disk[]>([]);
  const [asking, setAsking] = useState<Disk | null>(null);
  const [busy, setBusy] = useState("");
  const [step, setStep] = useState("");
  const [note, setNote] = useState("");
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
    let result: { before: number; after: number } | null = null;
    await run(command, () => call<{ before: number; after: number }>("CompactWSLDisk", d.distro).then((r) => (result = r)));
    setBusy("");
    setStep("");
    if (result) {
      const r = result as { before: number; after: number };
      setNote(`${d.distro}의 디스크: ${bytes(r.before)} → ${bytes(r.after)} (${bytes(Math.max(0, r.before - r.after))} 줄었습니다)`);
    }
    load();
  };

  return (
    <div className="panel" data-testid="wsl-disks">
      <h2>WSL 가상 디스크</h2>
      <p className="muted">
        WSL의 배포판(BoxForge, Kiri, Docker 등)마다 가상 디스크 파일(ext4.vhdx)이 있습니다. 안에서 이미지나 컨테이너를 지워도 이 파일은 줄지 않습니다. "줄이기"는 지운 만큼을
        Windows로 돌려줍니다. 먼저 안 쓰는 이미지 · 컨테이너를 정리하면 더 많이 줄어듭니다.
      </p>
      {note && <Note onClose={() => setNote("")}>{note}</Note>}
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
            <th>크기</th>
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
              <td>{bytes(d.bytes)}</td>
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
